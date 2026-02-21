const { Router } = require("express");
const { adminAuth } = require("../middleware/adminAuth.cjs");
const { pool } = require("../db/pool.cjs");
const { sendInternalError } = require("../utils/errorResponse.cjs");

const router = Router();

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function requireSuperAdmin(req, res) {
  if (!req.admin || req.admin.role !== "super_admin") {
    res.status(403).json({ error: "super admin required" });
    return false;
  }
  return true;
}

function parseDueDateUtc(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;

  return new Date(Date.UTC(year, month - 1, day));
}

function toYmdUtc(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function reminderTypeForDueDate(dueDateUtc, now = new Date()) {
  if (!(dueDateUtc instanceof Date) || Number.isNaN(dueDateUtc.getTime())) return null;

  const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const diffDays = Math.floor((dueDateUtc.getTime() - todayUtcMs) / ONE_DAY_MS);

  if (diffDays === 7) return "due_7d";
  if (diffDays === 1) return "due_1d";
  if (diffDays < 0) return "overdue";
  return null;
}

function buildReminderContent(device, reminderType, dueDateUtc) {
  const dueYmd = toYmdUtc(dueDateUtc) || "unknown";
  const deviceCode = String(device?.device_code || "").trim() || "this device";
  const planName = String(device?.plan_name || "").trim();
  const customerName = String(device?.customer_name || "").trim();

  const customerPart = customerName ? `${customerName}, ` : "";
  const planPart = planName ? ` (${planName})` : "";

  if (reminderType === "due_7d") {
    return {
      title: "Subscription due in 7 days",
      message: `${customerPart}your subscription${planPart} for device ${deviceCode} is due on ${dueYmd}.`,
      ttlHours: 36,
    };
  }

  if (reminderType === "due_1d") {
    return {
      title: "Subscription due tomorrow",
      message: `${customerPart}your subscription${planPart} for device ${deviceCode} is due on ${dueYmd}.`,
      ttlHours: 36,
    };
  }

  return {
    title: "Subscription overdue",
    message: `${customerPart}your subscription${planPart} for device ${deviceCode} is overdue since ${dueYmd}.`,
    ttlHours: 24,
  };
}

async function createReminderIfNeeded(device, adminId) {
  const dueDateUtc = parseDueDateUtc(device?.whmcs_next_due_date);
  if (!dueDateUtc) return { created: false, reason: "no_due_date" };

  const reminderType = reminderTypeForDueDate(dueDateUtc);
  if (!reminderType) return { created: false, reason: "outside_window" };

  const status = String(device?.status || "").trim().toLowerCase();
  if (status && status !== "active") {
    return { created: false, reason: "device_not_active", reminder_type: reminderType };
  }

  const targetDeviceId = Number(device?.id || 0);
  if (!Number.isFinite(targetDeviceId) || targetDeviceId <= 0) {
    return { created: false, reason: "invalid_device_id", reminder_type: reminderType };
  }

  const content = buildReminderContent(device, reminderType, dueDateUtc);

  // Dedupe per device + reminder content + day
  const [existingRows] = await pool.execute(
    `
    SELECT id
    FROM app_notifications
    WHERE COALESCE(target_scope, 'mass')='device'
      AND target_device_id=?
      AND title=?
      AND message=?
      AND DATE(created_at)=UTC_DATE()
    LIMIT 1
    `,
    [targetDeviceId, content.title, content.message]
  );

  if (existingRows[0]) {
    return {
      created: false,
      reason: "already_created_today",
      reminder_type: reminderType,
      notification_id: Number(existingRows[0].id),
    };
  }

  const [ins] = await pool.execute(
    `
    INSERT INTO app_notifications
      (title, message, status, target_scope, target_platform, target_device_id, starts_at, ends_at, created_by_admin_id, created_at, updated_at)
    VALUES
      (?, ?, 'active', 'device', 'all', ?, NOW(), DATE_ADD(NOW(), INTERVAL ? HOUR), ?, NOW(), NOW())
    `,
    [content.title, content.message, targetDeviceId, content.ttlHours, adminId || null]
  );

  return {
    created: true,
    reminder_type: reminderType,
    notification_id: Number(ins?.insertId || 0) || null,
  };
}

router.post("/whmcs/reminders/run", adminAuth, async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const deviceCode = String(req.body?.device_code || req.query?.device_code || "").trim();
    const limitRaw = Number(req.body?.limit || req.query?.limit || 500);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2000, Math.trunc(limitRaw))) : 500;

    const whereParts = ["d.whmcs_next_due_date IS NOT NULL"];
    const params = [];

    if (deviceCode) {
      whereParts.push("d.device_code=?");
      params.push(deviceCode);
    }

    const [rows] = await pool.execute(
      `
      SELECT
        d.id,
        d.device_code,
        d.customer_name,
        d.plan_name,
        d.status,
        d.whmcs_billing_status,
        d.whmcs_next_due_date
      FROM devices d
      WHERE ${whereParts.join(" AND ")}
      ORDER BY d.whmcs_next_due_date ASC
      LIMIT ${limit}
      `,
      params
    );

    let created = 0;
    let skipped = 0;

    const results = [];
    for (const device of rows) {
      const out = await createReminderIfNeeded(device, req.admin?.id || null);
      if (out?.created) created += 1;
      else skipped += 1;

      results.push({
        device_code: device.device_code,
        whmcs_next_due_date: device.whmcs_next_due_date,
        ...out,
      });
    }

    return res.json({
      ok: true,
      scanned: rows.length,
      created,
      skipped,
      results,
    });
  } catch (err) {
    if (err?.code === "ER_NO_SUCH_TABLE") {
      return res.status(500).json({
        error: "app_notifications table missing",
        hint: "Run DB migration to create app_notifications table",
      });
    }
    return sendInternalError(req, res, "admin/whmcs/reminders/run", err);
  }
});

module.exports = router;
module.exports.createReminderIfNeeded = createReminderIfNeeded;
