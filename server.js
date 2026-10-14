'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'siberian-detailing.db');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'Asia/Novosibirsk';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

const SERVICES = [
    { id: 'tint_rear_hemi', name: 'Тонировка задней полусферы', price: 4300, group: 'tint', vehicleSurcharge: true },
    { id: 'tint_rear_sides', name: 'Тонировка задних боковых стёкол', price: 1900, group: 'tint', vehicleSurcharge: true },
    { id: 'tint_rear_window', name: 'Тонировка заднего стекла', price: 2400, group: 'tint', vehicleSurcharge: true },
    { id: 'tint_front_hemi', name: 'Тонировка передней полусферы', price: 4200, group: 'tint', vehicleSurcharge: true },
    { id: 'tint_front_sides', name: 'Тонировка передних боковых стёкол', price: 1900, group: 'tint', vehicleSurcharge: true },
    { id: 'tint_windshield', name: 'Тонировка лобового стекла', price: 2300, group: 'tint', vehicleSurcharge: true },
    { id: 'tint_full', name: 'Тонировка в круг', price: 8500, group: 'tint', vehicleSurcharge: true },
    { id: 'headlights', name: 'Полировка фар (пара)', price: 1000 },
    { id: 'polish_light', name: 'Лёгкая полировка кузова', price: 7000, group: 'body_polish', isFrom: true },
    { id: 'polish_deep', name: 'Глубокая полировка кузова', price: 11000, group: 'body_polish', isFrom: true },
    { id: 'clean_light', name: 'Лёгкая чистка салона без разбора', price: 2500, group: 'cleaning' },
    { id: 'clean_full', name: 'Полная бюджетная чистка без разбора', price: 3400, group: 'cleaning', isFrom: true }
];

const VEHICLES = [
    { id: 'sedan', name: 'Седан / хэтчбек', tintSurcharge: 0 },
    { id: 'wagon_suv', name: 'Универсал / джип', tintSurcharge: 100 }
];

const ALL_TIMES = Array.from({ length: 10 }, (_, index) => `${String(index + 13).padStart(2, '0')}:00`);
const BOOKING_STATUSES = new Set(['new', 'confirmed', 'in_progress', 'completed', 'cancelled']);

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        car TEXT NOT NULL DEFAULT '',
        primary_service TEXT NOT NULL,
        services_json TEXT NOT NULL DEFAULT '[]',
        vehicle_class TEXT NOT NULL DEFAULT 'sedan',
        total INTEGER,
        duration_hours INTEGER,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'new'
            CHECK (status IN ('new', 'confirmed', 'in_progress', 'completed', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date, time);
    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_active_booking_slot
        ON bookings(date, time) WHERE status != 'cancelled';

    CREATE TABLE IF NOT EXISTS schedule_slots (
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
        PRIMARY KEY (date, time)
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
        id TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    );
`);

const generatedAdminPassword = crypto.randomBytes(12).toString('base64url');
const adminPassword = process.env.ADMIN_PASSWORD || generatedAdminPassword;
const usingTemporaryPassword = !process.env.ADMIN_PASSWORD;

class HttpError extends Error {
    constructor(status, message, code = 'request_error') {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const serviceById = new Map(SERVICES.map((service) => [service.id, service]));
const vehicleById = new Map(VEHICLES.map((vehicle) => [vehicle.id, vehicle]));
const rateLimits = new Map();

function setSecurityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src https://yandex.ru; object-src 'none'; base-uri 'none'; form-action 'self'");
}

function sendJson(res, status, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        ...extraHeaders
    });
    res.end(body);
}

function sendError(res, error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : 'Внутренняя ошибка сервера';
    const code = error instanceof HttpError ? error.code : 'internal_error';
    if (status >= 500) console.error(error);
    sendJson(res, status, { error: message, code });
}

function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];

        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new HttpError(413, 'Слишком большой запрос', 'body_too_large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(new HttpError(400, 'Некорректный JSON', 'invalid_json'));
            }
        });

        req.on('error', reject);
    });
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    return String(forwarded ? forwarded.split(',')[0] : req.socket.remoteAddress || 'unknown').trim();
}

function checkRateLimit(key, limit, windowMs) {
    const now = Date.now();
    const current = rateLimits.get(key);
    if (!current || current.resetAt <= now) {
        rateLimits.set(key, { count: 1, resetAt: now + windowMs });
        return;
    }
    current.count += 1;
    if (current.count > limit) throw new HttpError(429, 'Слишком много попыток. Попробуйте позже.', 'rate_limited');
}

function assertSameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return;
    const protocol = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const expected = `${protocol}://${req.headers.host}`;
    if (origin !== expected) throw new HttpError(403, 'Недопустимый источник запроса', 'origin_rejected');
}

function parseCookies(req) {
    return String(req.headers.cookie || '').split(';').reduce((cookies, part) => {
        const separator = part.indexOf('=');
        if (separator < 0) return cookies;
        const key = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        if (key) cookies[key] = decodeURIComponent(value);
        return cookies;
    }, {});
}

function getSession(req) {
    const sessionId = parseCookies(req).sd_session;
    if (!sessionId) return null;
    const session = db.prepare('SELECT id, csrf_token, expires_at FROM admin_sessions WHERE id = ?').get(sessionId);
    if (!session) return null;
    if (session.expires_at <= Date.now()) {
        db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(sessionId);
        return null;
    }
    return session;
}

function requireAdmin(req, requireCsrf = false) {
    const session = getSession(req);
    if (!session) throw new HttpError(401, 'Требуется вход в админ-панель', 'unauthorized');
    if (requireCsrf && req.headers['x-csrf-token'] !== session.csrf_token) {
        throw new HttpError(403, 'Сессия формы устарела. Обновите страницу.', 'csrf_failed');
    }
    return session;
}

function timingSafePasswordMatch(candidate) {
    const expectedHash = crypto.createHash('sha256').update(adminPassword).digest();
    const candidateHash = crypto.createHash('sha256').update(String(candidate || '')).digest();
    return crypto.timingSafeEqual(expectedHash, candidateHash);
}

function sanitizeString(value, fieldName, maxLength, required = false) {
    const result = String(value ?? '').trim();
    if (required && !result) throw new HttpError(422, `Заполните поле «${fieldName}»`, 'validation_error');
    if (result.length > maxLength) throw new HttpError(422, `Поле «${fieldName}» слишком длинное`, 'validation_error');
    return result;
}

function normalizePhone(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 10) digits = `7${digits}`;
    if (digits.startsWith('8')) digits = `7${digits.slice(1)}`;
    if (!/^7\d{10}$/.test(digits)) throw new HttpError(422, 'Введите корректный номер телефона', 'validation_error');
    return `+${digits}`;
}

function isValidDateKey(dateKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey))) return false;
    const [year, month, day] = dateKey.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function businessNowParts() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: BUSINESS_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(new Date());
    const result = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
        date: `${result.year}-${result.month}-${result.day}`,
        minutes: Number(result.hour) * 60 + Number(result.minute)
    };
}

function shiftDate(dateKey, days) {
    const [year, month, day] = dateKey.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function daysBetween(from, to) {
    const parse = (value) => {
        const [year, month, day] = value.split('-').map(Number);
        return Date.UTC(year, month - 1, day);
    };
    return Math.round((parse(to) - parse(from)) / 86400000);
}

function getDefaultTimes(dateKey) {
    const [year, month, day] = dateKey.split('-').map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return weekday === 0 || weekday === 6
        ? ALL_TIMES.slice()
        : ALL_TIMES.filter((time) => time >= '17:00');
}

function getConfiguredTimes(dateKey) {
    const rows = db.prepare('SELECT time, is_available FROM schedule_slots WHERE date = ? ORDER BY time').all(dateKey);
    return rows.length
        ? rows.filter((row) => row.is_available === 1 && ALL_TIMES.includes(row.time)).map((row) => row.time)
        : getDefaultTimes(dateKey);
}

function getAvailableTimes(dateKey, includePast = false) {
    const booked = new Set(db.prepare("SELECT time FROM bookings WHERE date = ? AND status != 'cancelled'").all(dateKey).map((row) => row.time));
    const now = businessNowParts();
    return getConfiguredTimes(dateKey).filter((time) => {
        if (booked.has(time)) return false;
        if (!includePast && dateKey === now.date) {
            const [hour, minute] = time.split(':').map(Number);
            return hour * 60 + minute > now.minutes + 60;
        }
        return true;
    });
}

function validateBookableDate(dateKey) {
    if (!isValidDateKey(dateKey)) throw new HttpError(422, 'Некорректная дата', 'validation_error');
    const today = businessNowParts().date;
    const difference = daysBetween(today, dateKey);
    if (difference < 0) throw new HttpError(422, 'Нельзя записаться на прошедшую дату', 'validation_error');
    if (difference > 90) throw new HttpError(422, 'Запись доступна не более чем на 90 дней вперёд', 'validation_error');
}

function calculateEstimate(serviceIds, vehicleClass) {
    const uniqueIds = [...new Set(Array.isArray(serviceIds) ? serviceIds : [])];
    const services = uniqueIds.map((id) => serviceById.get(id)).filter(Boolean);
    const vehicle = vehicleById.get(vehicleClass) || vehicleById.get('sedan');
    const selectedGroups = new Set();
    services.forEach((service) => {
        if (!service.group) return;
        if (selectedGroups.has(service.group)) {
            throw new HttpError(422, 'Выберите только один вариант внутри каждой категории услуг', 'validation_error');
        }
        selectedGroups.add(service.group);
    });
    const total = services.length
        ? services.reduce((sum, service) => sum + service.price + (service.vehicleSurcharge ? vehicle.tintSurcharge : 0), 0)
        : null;
    return { services, vehicle, total, durationHours: null, hasFromPrice: services.some((service) => service.isFrom) };
}

function mapBooking(row) {
    let serviceIds = [];
    try { serviceIds = JSON.parse(row.services_json); } catch { serviceIds = []; }
    return {
        id: row.id,
        name: row.name,
        phone: row.phone,
        car: row.car,
        primaryService: row.primary_service,
        serviceIds,
        services: serviceIds.map((id) => serviceById.get(id)?.name).filter(Boolean),
        vehicleClass: row.vehicle_class,
        total: row.total,
        durationHours: row.duration_hours,
        date: row.date,
        time: row.time,
        comment: row.comment,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

async function notifyBooking(booking) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    const total = booking.total ? `${booking.total.toLocaleString('ru-RU')} ₽` : 'уточняется';
    const text = [
        '🚘 Новая запись Siberian Detailing',
        `Имя: ${booking.name}`,
        `Телефон: ${booking.phone}`,
        `Автомобиль: ${booking.car || 'не указан'}`,
        `Услуги: ${booking.services.join(', ') || booking.primaryService}`,
        `Дата: ${booking.date} в ${booking.time}`,
        `Стоимость: ${total}`,
        booking.comment ? `Комментарий: ${booking.comment}` : ''
    ].filter(Boolean).join('\n');

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text })
    });
    if (!response.ok) throw new Error(`Telegram notification failed: ${response.status}`);
}

function createBooking(body) {
    const name = sanitizeString(body.name, 'Имя', 80, true);
    const phone = normalizePhone(body.phone);
    const car = sanitizeString(body.car, 'Автомобиль', 120);
    const primaryService = sanitizeString(body.primaryService, 'Основная услуга', 120, true);
    const comment = sanitizeString(body.comment, 'Комментарий', 1000);
    const date = String(body.date || '');
    const time = String(body.time || '');
    const vehicleClass = vehicleById.has(body.vehicleClass) ? body.vehicleClass : 'sedan';
    const requestedServiceIds = Array.isArray(body.serviceIds) ? body.serviceIds.filter((id) => serviceById.has(id)) : [];

    validateBookableDate(date);
    if (!/^\d{2}:\d{2}$/.test(time) || !ALL_TIMES.includes(time)) {
        throw new HttpError(422, 'Некорректное время записи', 'validation_error');
    }

    const estimate = calculateEstimate(requestedServiceIds, vehicleClass);
    const nowIso = new Date().toISOString();
    const booking = {
        id: crypto.randomUUID(),
        name,
        phone,
        car,
        primaryService,
        serviceIds: estimate.services.map((service) => service.id),
        services: estimate.services.map((service) => service.name),
        vehicleClass: estimate.vehicle.id,
        total: estimate.total,
        durationHours: estimate.durationHours,
        date,
        time,
        comment,
        status: 'new',
        createdAt: nowIso,
        updatedAt: nowIso
    };

    db.exec('BEGIN IMMEDIATE');
    try {
        if (!getAvailableTimes(date).includes(time)) {
            throw new HttpError(409, 'Это время уже занято или недоступно', 'slot_unavailable');
        }
        db.prepare(`
            INSERT INTO bookings (
                id, name, phone, car, primary_service, services_json, vehicle_class,
                total, duration_hours, date, time, comment, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            booking.id, booking.name, booking.phone, booking.car, booking.primaryService,
            JSON.stringify(booking.serviceIds), booking.vehicleClass, booking.total,
            booking.durationHours, booking.date, booking.time, booking.comment,
            booking.status, booking.createdAt, booking.updatedAt
        );
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        if (String(error.message).includes('UNIQUE constraint failed')) {
            throw new HttpError(409, 'Это время уже занято', 'slot_unavailable');
        }
        throw error;
    }

    return booking;
}

function getAdminStats() {
    const today = businessNowParts().date;
    const [year, month, day] = today.split('-').map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const weekStart = shiftDate(today, -((weekday + 6) % 7));
    const weekEnd = shiftDate(weekStart, 6);
    return {
        total: db.prepare('SELECT COUNT(*) AS count FROM bookings').get().count,
        newCount: db.prepare("SELECT COUNT(*) AS count FROM bookings WHERE status = 'new'").get().count,
        today: db.prepare("SELECT COUNT(*) AS count FROM bookings WHERE date = ? AND status != 'cancelled'").get(today).count,
        week: db.prepare("SELECT COUNT(*) AS count FROM bookings WHERE date BETWEEN ? AND ? AND status != 'cancelled'").get(weekStart, weekEnd).count,
        availableToday: getAvailableTimes(today).length
    };
}

function loginCookie(req, sessionId, maxAge) {
    const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    return `sd_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function contentType(filePath) {
    const types = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.txt': 'text/plain; charset=utf-8'
    };
    return types[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function serveStatic(req, res, pathname) {
    let relativePath;
    if (pathname === '/') relativePath = 'index.html';
    else if (pathname === '/admin') relativePath = 'admin.html';
    else relativePath = decodeURIComponent(pathname).replace(/^\/+/, '');

    const allowed = relativePath === 'index.html' || relativePath === 'admin.html' ||
        relativePath.startsWith('css/') || relativePath.startsWith('js/') || relativePath.startsWith('img/');
    if (!allowed) throw new HttpError(404, 'Страница не найдена', 'not_found');

    const filePath = path.resolve(ROOT, relativePath);
    if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
        throw new HttpError(403, 'Доступ запрещён', 'forbidden');
    }

    let stat;
    try { stat = fs.statSync(filePath); } catch { throw new HttpError(404, 'Файл не найден', 'not_found'); }
    if (!stat.isFile()) throw new HttpError(404, 'Файл не найден', 'not_found');

    const isHtml = path.extname(filePath).toLowerCase() === '.html';
    res.writeHead(200, {
        'Content-Type': contentType(filePath),
        'Content-Length': stat.size,
        'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=86400'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res, url) {
    const { pathname, searchParams } = url;

    if (req.method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, database: 'connected', time: new Date().toISOString() });
    }

    if (req.method === 'GET' && pathname === '/api/config') {
        const businessDate = businessNowParts().date;
        return sendJson(res, 200, {
            services: SERVICES,
            vehicles: VEHICLES,
            businessDate,
            bookingMaxDate: shiftDate(businessDate, 90),
            business: {
                phone: '+79237773752',
                address: 'г. Новосибирск, ул. Ельцовская, 8В',
                weekdayHours: '17:00–22:00',
                weekendHours: '13:00–22:00'
            }
        });
    }

    if (req.method === 'GET' && pathname === '/api/slots') {
        const date = String(searchParams.get('date') || '');
        validateBookableDate(date);
        return sendJson(res, 200, { date, slots: getAvailableTimes(date) });
    }

    if (req.method === 'POST' && pathname === '/api/bookings') {
        assertSameOrigin(req);
        checkRateLimit(`booking:${getClientIp(req)}`, 10, 60 * 60 * 1000);
        const body = await parseJsonBody(req);
        const booking = createBooking(body);
        notifyBooking(booking).catch((error) => console.error(error.message));
        return sendJson(res, 201, {
            booking: {
                id: booking.id,
                date: booking.date,
                time: booking.time,
                total: booking.total,
                durationHours: booking.durationHours
            }
        });
    }

    if (req.method === 'GET' && pathname === '/api/admin/session') {
        const session = getSession(req);
        return sendJson(res, 200, session
            ? { authenticated: true, csrfToken: session.csrf_token }
            : { authenticated: false });
    }

    if (req.method === 'POST' && pathname === '/api/admin/login') {
        assertSameOrigin(req);
        checkRateLimit(`login:${getClientIp(req)}`, 5, 15 * 60 * 1000);
        const body = await parseJsonBody(req);
        if (!timingSafePasswordMatch(body.password)) {
            throw new HttpError(401, 'Неверный пароль', 'invalid_credentials');
        }
        db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(Date.now());
        const sessionId = crypto.randomBytes(32).toString('base64url');
        const csrfToken = crypto.randomBytes(24).toString('base64url');
        const now = Date.now();
        db.prepare('INSERT INTO admin_sessions (id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?)')
            .run(sessionId, csrfToken, now + SESSION_TTL_MS, now);
        return sendJson(res, 200, { authenticated: true, csrfToken }, {
            'Set-Cookie': loginCookie(req, sessionId, Math.floor(SESSION_TTL_MS / 1000))
        });
    }

    if (pathname.startsWith('/api/admin/')) {
        const mutating = !['GET', 'HEAD'].includes(req.method);
        if (mutating) assertSameOrigin(req);
        const session = requireAdmin(req, mutating);

        if (req.method === 'POST' && pathname === '/api/admin/logout') {
            db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(session.id);
            return sendJson(res, 200, { ok: true }, {
                'Set-Cookie': loginCookie(req, '', 0)
            });
        }

        if (req.method === 'GET' && pathname === '/api/admin/dashboard') {
            return sendJson(res, 200, { stats: getAdminStats() });
        }

        if (req.method === 'GET' && pathname === '/api/admin/bookings') {
            const status = String(searchParams.get('status') || '');
            const date = String(searchParams.get('date') || '');
            const search = String(searchParams.get('search') || '').trim().slice(0, 80);
            const conditions = [];
            const values = [];
            if (status && BOOKING_STATUSES.has(status)) { conditions.push('status = ?'); values.push(status); }
            if (date && isValidDateKey(date)) { conditions.push('date = ?'); values.push(date); }
            if (search) {
                conditions.push('(name LIKE ? OR phone LIKE ? OR car LIKE ?)');
                const pattern = `%${search}%`;
                values.push(pattern, pattern, pattern);
            }
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const rows = db.prepare(`SELECT * FROM bookings ${where} ORDER BY date ASC, time ASC LIMIT 500`).all(...values);
            return sendJson(res, 200, { bookings: rows.map(mapBooking) });
        }

        const bookingMatch = pathname.match(/^\/api\/admin\/bookings\/([a-f0-9-]+)$/i);
        if (bookingMatch && req.method === 'PATCH') {
            const body = await parseJsonBody(req);
            if (!BOOKING_STATUSES.has(body.status)) throw new HttpError(422, 'Некорректный статус', 'validation_error');
            const current = db.prepare('SELECT id, date, time FROM bookings WHERE id = ?').get(bookingMatch[1]);
            if (!current) throw new HttpError(404, 'Запись не найдена', 'not_found');
            if (body.status !== 'cancelled') {
                const conflict = db.prepare("SELECT id FROM bookings WHERE date = ? AND time = ? AND status != 'cancelled' AND id != ?")
                    .get(current.date, current.time, current.id);
                if (conflict) throw new HttpError(409, 'Этот интервал уже занят другой активной записью', 'slot_unavailable');
            }
            const result = db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?')
                .run(body.status, new Date().toISOString(), bookingMatch[1]);
            return sendJson(res, 200, { ok: true });
        }

        if (bookingMatch && req.method === 'DELETE') {
            const result = db.prepare('DELETE FROM bookings WHERE id = ?').run(bookingMatch[1]);
            if (!result.changes) throw new HttpError(404, 'Запись не найдена', 'not_found');
            return sendJson(res, 200, { ok: true });
        }

        if (pathname === '/api/admin/slots' && req.method === 'GET') {
            const date = String(searchParams.get('date') || '');
            if (!isValidDateKey(date)) throw new HttpError(422, 'Некорректная дата', 'validation_error');
            const configured = db.prepare('SELECT time, is_available FROM schedule_slots WHERE date = ? ORDER BY time').all(date);
            const available = configured.length
                ? configured.filter((row) => row.is_available === 1 && ALL_TIMES.includes(row.time)).map((row) => row.time)
                : getDefaultTimes(date);
            const booked = db.prepare("SELECT time FROM bookings WHERE date = ? AND status != 'cancelled'").all(date).map((row) => row.time);
            return sendJson(res, 200, { date, allTimes: ALL_TIMES, available, booked, isCustom: configured.length > 0 });
        }

        if (pathname === '/api/admin/slots' && req.method === 'PUT') {
            const body = await parseJsonBody(req);
            const date = String(body.date || '');
            if (!isValidDateKey(date)) throw new HttpError(422, 'Некорректная дата', 'validation_error');
            const availableSet = new Set(Array.isArray(body.available) ? body.available.filter((time) => ALL_TIMES.includes(time)) : []);
            db.exec('BEGIN IMMEDIATE');
            try {
                db.prepare('DELETE FROM schedule_slots WHERE date = ?').run(date);
                const insert = db.prepare('INSERT INTO schedule_slots (date, time, is_available) VALUES (?, ?, ?)');
                ALL_TIMES.forEach((time) => insert.run(date, time, availableSet.has(time) ? 1 : 0));
                db.exec('COMMIT');
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
            return sendJson(res, 200, { ok: true, date, available: [...availableSet].sort() });
        }

        if (pathname === '/api/admin/slots/reset' && req.method === 'POST') {
            const body = await parseJsonBody(req);
            const date = String(body.date || '');
            if (!isValidDateKey(date)) throw new HttpError(422, 'Некорректная дата', 'validation_error');
            db.prepare('DELETE FROM schedule_slots WHERE date = ?').run(date);
            return sendJson(res, 200, { ok: true, date, available: getDefaultTimes(date) });
        }
    }

    throw new HttpError(404, 'API-метод не найден', 'not_found');
}

async function handleRequest(req, res) {
    setSecurityHeaders(res);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Метод не поддерживается', 'method_not_allowed');
    return serveStatic(req, res, url.pathname);
}

const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => sendError(res, error));
});

server.listen(PORT, HOST, () => {
    console.log(`Siberian Detailing: http://${HOST}:${PORT}`);
    console.log(`Админ-панель: http://${HOST}:${PORT}/admin`);
    if (usingTemporaryPassword) {
        console.log(`Временный пароль администратора: ${adminPassword}`);
        console.log('Для постоянного пароля задайте переменную ADMIN_PASSWORD перед запуском.');
    }
});

function shutdown() {
    server.close(() => {
        db.close();
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
