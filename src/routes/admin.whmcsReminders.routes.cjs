const { Router } = require("express");
const { adminAuth } = require("../middleware/adminAuth.cjs");
const { pool } = require("../db/pool.cjs");
const { env } = require("../config/env.cjs");
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

function getAutomationSecret(req) {
  return String(
    req.header("x-whmcs-reminder-secret") ||
    req.body?.secret ||
    req.query?.secret ||
    ""
  ).trim();
}

function requireAutomationSecret(req, res) {
  const expected = String(env.WHMCS_REMINDER_SECRET || "").trim();
  if (!expected) {
    res.status(500).json({
      error: "WHMCS automation not configured",
      hint: "Set WHMCS_REMINDER_SECRET in the API environment",
    });
    return false;
  }

  const provided = getAutomationSecret(req);
  if (!provided || provided !== expected) {
    res.status(401).json({ error: "invalid automation secret" });
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

function normalizeWhmcsStatus(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return raw.length > 64 ? raw.slice(0, 64) : raw;
}

function normalizePlanName(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return raw.length > 255 ? raw.slice(0, 255) : raw;
}

function toMysqlDatetime(value) {
  if (!value) return null;

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;

  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function toMysqlDateOnly(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "0000-00-00") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw} 00:00:00`;
  return toMysqlDatetime(raw);
}

function isSchemaMismatch(err) {
  return ["ER_BAD_FIELD_ERROR", "ER_DUP_FIELDNAME", "ER_NO_SUCH_TABLE"].includes(err?.code);
}

async function fetchWhmcsServiceById(serviceId) {
  const apiUrl = String(env.WHMCS_API_URL || "").trim();
  const identifier = String(env.WHMCS_API_IDENTIFIER || "").trim();
  const secret = String(env.WHMCS_API_SECRET || "").trim();

  if (!apiUrl || !identifier || !secret) {
    const err = new Error("WHMCS API not configured");
    err.status = 500;
    throw err;
  }

  const body = new URLSearchParams({
    action: "GetClientsProducts",
    serviceid: String(serviceId),
    identifier,
    secret,
    responsetype: "json",
  });

  const resp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "streamin-api/1.0",
    },
    body: body.toString(),
  });

  const text = await resp.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error("WHMCS returned invalid JSON");
    err.status = 502;
    err.body = text.slice(0, 300);
    throw err;
  }

  if (!resp.ok) {
    const err = new Error("WHMCS request failed");
    err.status = resp.status;
    err.body = text.slice(0, 300);
    throw err;
  }

  if (String(data?.result || "").toLowerCase() !== "success") {
    const err = new Error(data?.message || "WHMCS API error");
    err.status = 502;
    throw err;
  }

  let products = data?.products?.product || [];
  if (!Array.isArray(products)) {
    products = products && typeof products === "object" ? [products] : [];
  }

  const matched =
    products.find((p) => Number(p?.id || p?.serviceid || 0) === Number(serviceId)) ||
    products[0] ||
    null;

  if (!matched) return null;

  return {
    service_id: Number(matched?.id || matched?.serviceid || serviceId) || Number(serviceId),
    client_id: Number(matched?.clientid || 0) || null,
    status: normalizeWhmcsStatus(matched?.status),
    next_due_date: toMysqlDateOnly(matched?.nextduedate),
    raw: matched,
  };
}

function extractWhmcsPlanName(rawService) {
  if (!rawService || typeof rawService !== "object") return null;

  const candidates = [
    rawService.productname,
    rawService.product_name,
    rawService.name,
    rawService.groupname,
  ];

  for (const candidate of candidates) {
    const planName = normalizePlanName(candidate);
    if (planName) return planName;
  }

  return null;
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

function isActiveBillingStatus(value) {
  return String(value || "").trim().toLowerCase() === "active";
}

async function createPaymentConfirmationIfNeeded(previousDevice, currentDevice, adminId) {
  const targetDeviceId = Number(currentDevice?.id || 0);
  if (!Number.isFinite(targetDeviceId) || targetDeviceId <= 0) {
    return { created: false, reason: "invalid_device_id" };
  }

  const deviceStatus = String(currentDevice?.status || "").trim().toLowerCase();
  if (deviceStatus && deviceStatus !== "active") {
    return { created: false, reason: "device_not_active" };
  }

  const previousDue = parseDueDateUtc(previousDevice?.whmcs_next_due_date);
  const currentDue = parseDueDateUtc(currentDevice?.whmcs_next_due_date);
  if (!currentDue) {
    return { created: false, reason: "no_current_due_date" };
  }

  const previousStatusActive = isActiveBillingStatus(previousDevice?.whmcs_billing_status);
  const currentStatusActive = isActiveBillingStatus(currentDevice?.whmcs_billing_status);

  const dueDateAdvanced = previousDue && currentDue.getTime() > previousDue.getTime();
  const becameActive = !previousStatusActive && currentStatusActive;

  if (!dueDateAdvanced && !becameActive) {
    return { created: false, reason: "not_a_payment_event" };
  }

  const dueYmd = toYmdUtc(currentDue) || "unknown";
  const customerName = String(currentDevice?.customer_name || "").trim();
  const deviceCode = String(currentDevice?.device_code || "").trim() || "this device";
  const planName = String(currentDevice?.plan_name || "").trim();
  const customerPart = customerName ? `${customerName}, ` : "";
  const planPart = planName ? ` (${planName})` : "";
  const title = "Payment received";
  const message = `${customerPart}payment received for device ${deviceCode}${planPart}. Next due date: ${dueYmd}.`;

  const [existingRows] = await pool.execute(
    `
    SELECT id
    FROM app_notifications
    WHERE COALESCE(target_scope, 'mass')='device'
      AND target_device_id=?
      AND title=?
      AND message=?
    LIMIT 1
    `,
    [targetDeviceId, title, message]
  );

  if (existingRows[0]) {
    return {
      created: false,
      reason: "already_created",
      notification_id: Number(existingRows[0].id),
    };
  }

  const [ins] = await pool.execute(
    `
    INSERT INTO app_notifications
      (title, message, status, target_scope, target_platform, target_device_id, starts_at, ends_at, created_by_admin_id, created_at, updated_at)
    VALUES
      (?, ?, 'active', 'device', 'all', ?, NOW(), DATE_ADD(NOW(), INTERVAL 24 HOUR), ?, NOW(), NOW())
    `,
    [title, message, targetDeviceId, adminId || null]
  );

  return {
    created: true,
    notification_id: Number(ins?.insertId || 0) || null,
    reason: dueDateAdvanced ? "due_date_advanced" : "status_became_active",
  };
}

function trialReminderTypeForExpiry(expiryDateUtc, now = new Date()) {
  if (!(expiryDateUtc instanceof Date) || Number.isNaN(expiryDateUtc.getTime())) return null;

  const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const diffDays = Math.floor((expiryDateUtc.getTime() - todayUtcMs) / ONE_DAY_MS);

  if (diffDays === 10) return "trial_10d";
  if (diffDays === 5) return "trial_5d";
  if (diffDays === 2) return "trial_2d";
  if (diffDays === 1) return "trial_1d";
  if (diffDays < 0) return "trial_expired";
  return null;
}

function buildTrialReminderContent(device, reminderType, expiryDateUtc) {
  const expiryYmd = toYmdUtc(expiryDateUtc) || "unknown";
  const deviceCode = String(device?.device_code || "").trim() || "this device";
  const planName = String(device?.plan_name || "").trim();
  const customerName = String(device?.customer_name || "").trim();
  const customerPart = customerName ? `${customerName}, ` : "";
  const planPart = planName ? ` (${planName})` : "";

  if (reminderType === "trial_expired") {
    return {
      title: "Your trial has expired",
      message: `${customerPart}your trial${planPart} for device ${deviceCode} expired on ${expiryYmd}.`,
      ttlHours: 24,
    };
  }

  const dayMap = {
    trial_10d: "10 days",
    trial_5d: "5 days",
    trial_2d: "2 days",
    trial_1d: "1 day",
  };

  return {
    title: `Trial expires in ${dayMap[reminderType]}`,
    message: `${customerPart}your trial${planPart} for device ${deviceCode} expires on ${expiryYmd}.`,
    ttlHours: reminderType === "trial_1d" ? 36 : 48,
  };
}

async function createTrialReminderIfNeeded(device, adminId) {
  const expiryDateUtc = parseDueDateUtc(device?.trial_expires_at);
  if (!expiryDateUtc) return { created: false, reason: "no_trial_expiry" };

  const reminderType = trialReminderTypeForExpiry(expiryDateUtc);
  if (!reminderType) return { created: false, reason: "outside_window" };

  const status = String(device?.status || "").trim().toLowerCase();
  if (status && status !== "active") {
    return { created: false, reason: "device_not_active", reminder_type: reminderType };
  }

  const targetDeviceId = Number(device?.id || 0);
  if (!Number.isFinite(targetDeviceId) || targetDeviceId <= 0) {
    return { created: false, reason: "invalid_device_id", reminder_type: reminderType };
  }

  const content = buildTrialReminderContent(device, reminderType, expiryDateUtc);

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

async function runReminderScan({ deviceCode = "", serviceId = 0, limit = 500, adminId = null } = {}) {
  const whereParts = ["d.whmcs_next_due_date IS NOT NULL"];
  const params = [];

  if (deviceCode) {
    whereParts.push("d.device_code=?");
    params.push(deviceCode);
  }

  if (Number.isFinite(serviceId) && serviceId > 0) {
    whereParts.push("d.whmcs_service_id=?");
    params.push(serviceId);
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
      d.whmcs_next_due_date,
      d.whmcs_service_id
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
    const out = await createReminderIfNeeded(device, adminId);
    if (out?.created) created += 1;
    else skipped += 1;

    results.push({
      device_code: device.device_code,
      whmcs_service_id: device.whmcs_service_id,
      whmcs_next_due_date: device.whmcs_next_due_date,
      ...out,
    });
  }

  return {
    scanned: rows.length,
    created,
    skipped,
    results,
  };
}

async function runTrialReminderScan({ deviceCode = "", limit = 500, adminId = null } = {}) {
  const whereParts = ["d.trial_expires_at IS NOT NULL"];
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
      d.trial_expires_at
    FROM devices d
    WHERE ${whereParts.join(" AND ")}
    ORDER BY d.trial_expires_at ASC
    LIMIT ${limit}
    `,
    params
  );

  let created = 0;
  let skipped = 0;
  const results = [];

  for (const device of rows) {
    const out = await createTrialReminderIfNeeded(device, adminId);
    if (out?.created) created += 1;
    else skipped += 1;

    results.push({
      device_code: device.device_code,
      trial_expires_at: device.trial_expires_at,
      ...out,
    });
  }

  return {
    scanned: rows.length,
    created,
    skipped,
    results,
  };
}

router.post("/whmcs/reminders/auto", async (req, res) => {
  try {
    if (!requireAutomationSecret(req, res)) return;

    const deviceCode = String(req.body?.device_code || req.query?.device_code || "").trim();
    const serviceIdRaw = Number(req.body?.whmcs_service_id || req.body?.service_id || req.query?.whmcs_service_id || req.query?.service_id || 0);
    const serviceId = Number.isFinite(serviceIdRaw) ? Math.max(0, Math.trunc(serviceIdRaw)) : 0;
    const limitRaw = Number(req.body?.limit || req.query?.limit || 500);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2000, Math.trunc(limitRaw))) : 500;

    const output = await runReminderScan({
      deviceCode,
      serviceId,
      limit,
      adminId: null,
    });
    const trial = await runTrialReminderScan({
      deviceCode,
      limit,
      adminId: null,
    });

    return res.json({
      ok: true,
      mode: serviceId > 0 || deviceCode ? "targeted" : "scan",
      ...output,
      trial,
    });
  } catch (err) {
    if (err?.code === "ER_NO_SUCH_TABLE") {
      return res.status(500).json({
        error: "app_notifications table missing",
        hint: "Run DB migration to create app_notifications table",
      });
    }
    return sendInternalError(req, res, "admin/whmcs/reminders/auto", err);
  }
});

router.post("/whmcs/payments/auto", async (req, res) => {
  try {
    if (!requireAutomationSecret(req, res)) return;

    const deviceCode = String(req.body?.device_code || req.query?.device_code || "").trim();
    const serviceIdRaw = Number(
      req.body?.whmcs_service_id ||
      req.body?.service_id ||
      req.query?.whmcs_service_id ||
      req.query?.service_id ||
      0
    );
    const serviceId = Number.isFinite(serviceIdRaw) ? Math.max(0, Math.trunc(serviceIdRaw)) : 0;
    const invoiceIdRaw = Number(req.body?.invoice_id || req.query?.invoice_id || 0);
    const invoiceId = Number.isFinite(invoiceIdRaw) ? Math.max(0, Math.trunc(invoiceIdRaw)) : 0;

    if (!deviceCode && serviceId <= 0) {
      return res.status(400).json({ error: "service_id or device_code required" });
    }

    const whereSql = deviceCode ? "device_code=?" : "whmcs_service_id=?";
    const whereValue = deviceCode || serviceId;

    const [devRows] = await pool.execute(
      `
      SELECT
        id,
        device_code,
        customer_name,
        plan_name,
        status,
        whmcs_client_id,
        whmcs_service_id,
        whmcs_billing_status,
        whmcs_next_due_date
      FROM devices
      WHERE ${whereSql}
      LIMIT 1
      `,
      [whereValue]
    );

    const dev = devRows[0];
    if (!dev) {
      return res.status(404).json({ error: "device not found" });
    }

    const resolvedServiceId = serviceId > 0 ? serviceId : Number(dev.whmcs_service_id || 0);
    if (!Number.isFinite(resolvedServiceId) || resolvedServiceId <= 0) {
      return res.status(400).json({ error: "whmcs_service_id required" });
    }

    const service = await fetchWhmcsServiceById(resolvedServiceId);
    if (!service) {
      return res.status(404).json({ error: "WHMCS service not found" });
    }

    const planName = extractWhmcsPlanName(service.raw) || dev.plan_name || null;

    await pool.execute(
      `
      UPDATE devices
      SET
        plan_name=?,
        whmcs_client_id=?,
        whmcs_service_id=?,
        whmcs_billing_status=?,
        whmcs_next_due_date=?,
        whmcs_last_sync_at=NOW(),
        updated_at=NOW()
      WHERE id=?
      `,
      [
        planName,
        service.client_id,
        service.service_id,
        service.status,
        service.next_due_date,
        dev.id,
      ]
    );

    const [rows] = await pool.execute(
      `
      SELECT
        d.id,
        d.device_code,
        d.customer_name,
        d.plan_name,
        d.status,
        d.whmcs_client_id,
        d.whmcs_service_id,
        d.whmcs_billing_status,
        d.whmcs_next_due_date,
        d.whmcs_last_sync_at
      FROM devices d
      WHERE d.id=?
      LIMIT 1
      `,
      [dev.id]
    );

    const currentDevice = rows[0] || null;
    let payment_confirmation = { created: false, reason: "helper_unavailable" };
    let trial_reminder = { created: false, reason: "helper_unavailable" };

    if (currentDevice && typeof createPaymentConfirmationIfNeeded === "function") {
      try {
        payment_confirmation = await createPaymentConfirmationIfNeeded(dev, currentDevice, null);
      } catch (confirmErr) {
        console.warn("[admin/whmcs/payments/auto] payment confirmation skipped:", confirmErr?.message || confirmErr);
        payment_confirmation = {
          created: false,
          reason: confirmErr?.code === "ER_NO_SUCH_TABLE" ? "app_notifications_missing" : "payment_confirmation_failed",
        };
      }
    }

    if (currentDevice && typeof createTrialReminderIfNeeded === "function") {
      try {
        trial_reminder = await createTrialReminderIfNeeded(currentDevice, null);
      } catch (trialErr) {
        console.warn("[admin/whmcs/payments/auto] trial reminder skipped:", trialErr?.message || trialErr);
        trial_reminder = {
          created: false,
          reason: trialErr?.code === "ER_NO_SUCH_TABLE" ? "app_notifications_missing" : "trial_reminder_failed",
        };
      }
    }

    return res.json({
      ok: true,
      mode: deviceCode ? "device" : "service",
      invoice_id: invoiceId || null,
      device: currentDevice,
      whmcs: {
        service_id: service.service_id,
        client_id: service.client_id,
        status: service.status,
        next_due_date: service.next_due_date,
        plan_name: planName,
      },
      payment_confirmation,
      trial_reminder,
    });
  } catch (err) {
    if (err?.message === "WHMCS API not configured") {
      return res.status(500).json({
        error: "WHMCS API not configured",
        hint: "Set WHMCS_API_URL, WHMCS_API_IDENTIFIER, WHMCS_API_SECRET",
      });
    }

    if (isSchemaMismatch(err)) {
      return res.status(500).json({
        error: "Database schema mismatch",
        hint:
          "Run DB migration for devices WHMCS fields (whmcs_client_id, whmcs_service_id, whmcs_billing_status, whmcs_next_due_date, whmcs_last_sync_at) and app_notifications table",
      });
    }

    if (typeof err?.status === "number" && err.status >= 400 && err.status < 600) {
      const upstreamStatus = Number(err.status);
      const upstreamBody = String(err?.body || "").trim();
      return res.status(502).json({
        error: `WHMCS request failed (HTTP ${upstreamStatus})`,
        hint:
          "Check WHMCS_API_URL (usually /includes/api.php), WHMCS API credentials, and firewall/IP allowlist",
        ...(upstreamBody ? { upstream: upstreamBody.slice(0, 240) } : {}),
      });
    }

    return sendInternalError(req, res, "admin/whmcs/payments/auto", err);
  }
});

router.post("/whmcs/reminders/run", adminAuth, async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const deviceCode = String(req.body?.device_code || req.query?.device_code || "").trim();
    const limitRaw = Number(req.body?.limit || req.query?.limit || 500);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2000, Math.trunc(limitRaw))) : 500;
    const output = await runReminderScan({
      deviceCode,
      limit,
      adminId: req.admin?.id || null,
    });
    const trial = await runTrialReminderScan({
      deviceCode,
      limit,
      adminId: req.admin?.id || null,
    });

    return res.json({
      ok: true,
      ...output,
      trial,
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
module.exports.createPaymentConfirmationIfNeeded = createPaymentConfirmationIfNeeded;
module.exports.createTrialReminderIfNeeded = createTrialReminderIfNeeded;
module.exports.extractWhmcsPlanName = extractWhmcsPlanName;
