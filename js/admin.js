document.addEventListener('DOMContentLoaded', () => {
    const loginScreen = document.getElementById('loginScreen');
    const dashboard = document.getElementById('dashboard');
    const loginForm = document.getElementById('loginForm');
    const loginMessage = document.getElementById('loginMessage');
    const passwordInput = document.getElementById('adminPassword');
    const toast = document.getElementById('toast');
    const bookingsList = document.getElementById('bookingsList');
    const scheduleDate = document.getElementById('scheduleDate');
    const adminSlots = document.getElementById('adminSlots');
    let csrfToken = '';
    let availableSlots = new Set();
    let bookedSlots = new Set();
    let allTimes = [];
    let filterTimer = null;

    const statusLabels = {
        new: 'Новая',
        confirmed: 'Подтверждена',
        in_progress: 'В работе',
        completed: 'Завершена',
        cancelled: 'Отменена'
    };

    const api = async (url, options = {}) => {
        const response = await fetch(url, {
            ...options,
            credentials: 'same-origin',
            headers: {
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...(!['GET', 'HEAD'].includes(options.method || 'GET') && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
                ...options.headers
            }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            if (response.status === 401 && url !== '/api/admin/login') showLogin();
            const error = new Error(payload.error || 'Не удалось выполнить запрос');
            error.status = response.status;
            throw error;
        }
        return payload;
    };

    const localDateKey = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    const formatDate = (dateKey, options = {}) => new Date(`${dateKey}T12:00:00`).toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        ...options
    });

    const showToast = (message, isError = false) => {
        toast.textContent = message;
        toast.classList.toggle('is-error', isError);
        toast.classList.add('is-visible');
        clearTimeout(showToast.timer);
        showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), 2800);
    };

    const showLogin = () => {
        csrfToken = '';
        dashboard.hidden = true;
        loginScreen.hidden = false;
        passwordInput.focus();
    };

    const showDashboard = async () => {
        loginScreen.hidden = true;
        dashboard.hidden = false;
        await refreshDashboard();
    };

    const setLoading = (button, loading, text = 'Подождите…') => {
        if (loading) {
            button.dataset.original = button.innerHTML;
            button.textContent = text;
            button.disabled = true;
        } else {
            button.innerHTML = button.dataset.original || button.innerHTML;
            button.disabled = false;
        }
    };

    loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = loginForm.querySelector('button[type="submit"]');
        loginMessage.textContent = '';
        if (!passwordInput.value) {
            loginMessage.textContent = 'Введите пароль';
            return;
        }
        setLoading(button, true, 'Проверяем…');
        try {
            const result = await api('/api/admin/login', {
                method: 'POST',
                body: JSON.stringify({ password: passwordInput.value })
            });
            csrfToken = result.csrfToken;
            passwordInput.value = '';
            await showDashboard();
        } catch (error) {
            loginMessage.textContent = error.message;
        } finally {
            setLoading(button, false);
        }
    });

    document.getElementById('togglePassword').addEventListener('click', (event) => {
        const show = passwordInput.type === 'password';
        passwordInput.type = show ? 'text' : 'password';
        event.currentTarget.textContent = show ? 'Скрыть' : 'Показать';
        event.currentTarget.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
    });

    document.getElementById('logoutButton').addEventListener('click', async () => {
        try { await api('/api/admin/logout', { method: 'POST' }); } catch {}
        showLogin();
    });

    const renderStats = (stats) => {
        document.getElementById('statTotal').textContent = stats.total;
        document.getElementById('statNew').textContent = stats.newCount;
        document.getElementById('statToday').textContent = stats.today;
        document.getElementById('statWeek').textContent = stats.week;
        document.getElementById('statAvailable').textContent = stats.availableToday;
        document.getElementById('newBadge').textContent = stats.newCount;
    };

    const loadStats = async () => {
        const result = await api('/api/admin/dashboard');
        renderStats(result.stats);
    };

    const appendText = (parent, tag, text, className = '') => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        element.textContent = text;
        parent.append(element);
        return element;
    };

    const renderBookingCard = (booking) => {
        const card = document.createElement('article');
        card.className = 'booking-card';

        const time = document.createElement('div');
        time.className = 'booking-time';
        appendText(time, 'span', formatDate(booking.date, { weekday: 'short' }));
        appendText(time, 'strong', booking.time);

        const client = document.createElement('div');
        client.className = 'booking-client';
        appendText(client, 'strong', booking.name);
        const phone = appendText(client, 'a', booking.phone);
        phone.href = `tel:${booking.phone}`;
        if (booking.car) appendText(client, 'small', booking.car);

        const details = document.createElement('div');
        details.className = 'booking-details';
        appendText(details, 'p', booking.services.length ? booking.services.join(', ') : booking.primaryService);
        appendText(details, 'p', booking.total ? `Расчёт: от ${Number(booking.total).toLocaleString('ru-RU')} ₽` : 'Стоимость уточняется');
        if (booking.comment) appendText(details, 'small', booking.comment);

        const controls = document.createElement('div');
        controls.className = 'booking-controls';
        const status = document.createElement('select');
        status.className = 'status-select';
        status.setAttribute('aria-label', `Статус заявки ${booking.name}`);
        Object.entries(statusLabels).forEach(([value, label]) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            option.selected = booking.status === value;
            status.append(option);
        });
        status.addEventListener('change', async () => {
            status.disabled = true;
            try {
                await api(`/api/admin/bookings/${booking.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status: status.value })
                });
                showToast('Статус обновлён');
                await Promise.all([loadStats(), loadSchedule()]);
            } catch (error) {
                showToast(error.message, true);
                status.value = booking.status;
            } finally {
                status.disabled = false;
            }
        });

        const actions = document.createElement('div');
        actions.className = 'booking-actions';
        const call = appendText(actions, 'a', 'Позвонить');
        call.href = `tel:${booking.phone}`;
        const remove = appendText(actions, 'button', 'Удалить', 'delete');
        remove.type = 'button';
        remove.addEventListener('click', async () => {
            if (!window.confirm(`Удалить запись ${booking.name} на ${booking.date} ${booking.time}?`)) return;
            remove.disabled = true;
            try {
                await api(`/api/admin/bookings/${booking.id}`, { method: 'DELETE' });
                showToast('Запись удалена');
                await Promise.all([loadStats(), loadBookings(), loadSchedule()]);
            } catch (error) {
                showToast(error.message, true);
                remove.disabled = false;
            }
        });
        controls.append(status, actions);
        card.append(time, client, details, controls);
        return card;
    };

    const loadBookings = async () => {
        bookingsList.replaceChildren();
        appendText(bookingsList, 'div', 'Загружаем заявки…', 'loading-state');
        const params = new URLSearchParams();
        const search = document.getElementById('bookingSearch').value.trim();
        const status = document.getElementById('bookingStatus').value;
        const date = document.getElementById('bookingDateFilter').value;
        if (search) params.set('search', search);
        if (status) params.set('status', status);
        if (date) params.set('date', date);
        try {
            const result = await api(`/api/admin/bookings?${params}`);
            bookingsList.replaceChildren();
            if (!result.bookings.length) {
                appendText(bookingsList, 'div', 'По выбранным условиям записей нет', 'empty-state');
                return;
            }
            result.bookings.forEach((booking) => bookingsList.append(renderBookingCard(booking)));
        } catch (error) {
            bookingsList.replaceChildren();
            appendText(bookingsList, 'div', error.message, 'empty-state');
        }
    };

    const renderSlots = () => {
        adminSlots.replaceChildren();
        allTimes.forEach((time) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'slot-button';
            button.textContent = time;
            if (bookedSlots.has(time)) {
                button.classList.add('is-booked');
                button.disabled = true;
                button.title = 'Интервал занят клиентом';
            } else if (availableSlots.has(time)) {
                button.classList.add('is-available');
            }
            button.addEventListener('click', () => {
                if (availableSlots.has(time)) availableSlots.delete(time);
                else availableSlots.add(time);
                renderSlots();
            });
            adminSlots.append(button);
        });
    };

    const loadSchedule = async () => {
        if (!scheduleDate.value || dashboard.hidden) return;
        adminSlots.replaceChildren();
        appendText(adminSlots, 'div', 'Загружаем расписание…', 'loading-state');
        try {
            const result = await api(`/api/admin/slots?date=${encodeURIComponent(scheduleDate.value)}`);
            allTimes = result.allTimes;
            availableSlots = new Set(result.available);
            bookedSlots = new Set(result.booked);
            renderSlots();
        } catch (error) {
            adminSlots.replaceChildren();
            appendText(adminSlots, 'div', error.message, 'empty-state');
        }
    };

    document.getElementById('saveSlots').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        setLoading(button, true, 'Сохраняем…');
        try {
            await api('/api/admin/slots', {
                method: 'PUT',
                body: JSON.stringify({ date: scheduleDate.value, available: [...availableSlots] })
            });
            showToast('Расписание сохранено');
            await Promise.all([loadStats(), loadSchedule()]);
        } catch (error) {
            showToast(error.message, true);
        } finally {
            setLoading(button, false);
        }
    });

    document.getElementById('defaultSlots').addEventListener('click', async () => {
        try {
            await api('/api/admin/slots/reset', {
                method: 'POST',
                body: JSON.stringify({ date: scheduleDate.value })
            });
            showToast('Стандартное расписание восстановлено');
            await Promise.all([loadStats(), loadSchedule()]);
        } catch (error) { showToast(error.message, true); }
    });

    document.getElementById('closeAllSlots').addEventListener('click', () => {
        availableSlots.clear();
        renderSlots();
        showToast('Все свободные интервалы отключены. Нажмите «Сохранить».');
    });

    document.querySelectorAll('.tabs button').forEach((button) => {
        button.addEventListener('click', () => {
            document.querySelectorAll('.tabs button').forEach((item) => item.classList.toggle('is-active', item === button));
            document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('is-active', panel.id === `panel-${button.dataset.tab}`));
            if (button.dataset.tab === 'schedule') loadSchedule();
        });
    });

    ['bookingSearch', 'bookingStatus', 'bookingDateFilter'].forEach((id) => {
        document.getElementById(id).addEventListener('input', () => {
            clearTimeout(filterTimer);
            filterTimer = setTimeout(loadBookings, 250);
        });
    });

    document.getElementById('clearFilters').addEventListener('click', () => {
        document.getElementById('bookingSearch').value = '';
        document.getElementById('bookingStatus').value = '';
        document.getElementById('bookingDateFilter').value = '';
        loadBookings();
    });

    scheduleDate.addEventListener('change', loadSchedule);
    document.getElementById('refreshButton').addEventListener('click', async () => {
        await refreshDashboard();
        showToast('Данные обновлены');
    });

    async function refreshDashboard() {
        await Promise.all([loadStats(), loadBookings(), loadSchedule()]);
    }

    async function init() {
        const now = new Date();
        document.getElementById('headerDate').textContent = now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
        scheduleDate.value = localDateKey(now);
        scheduleDate.min = localDateKey(now);
        try {
            const session = await api('/api/admin/session');
            if (!session.authenticated) return showLogin();
            csrfToken = session.csrfToken;
            await showDashboard();
        } catch {
            showLogin();
        }
    }

    init();
});
