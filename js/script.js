document.addEventListener('DOMContentLoaded', () => {
    const money = new Intl.NumberFormat('ru-RU');

    const getLocalDateKey = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    const apiRequest = async (url, options = {}) => {
        const response = await fetch(url, {
            ...options,
            headers: {
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...options.headers
            }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(payload.error || 'Не удалось выполнить запрос');
            error.status = response.status;
            error.code = payload.code;
            throw error;
        }
        return payload;
    };

    // Header and mobile navigation
    const siteHeader = document.getElementById('siteHeader');
    const menuToggle = document.getElementById('menuToggle');
    const siteNav = document.getElementById('siteNav');

    const updateHeader = () => siteHeader.classList.toggle('is-scrolled', window.scrollY > 18);
    updateHeader();
    window.addEventListener('scroll', updateHeader, { passive: true });

    const closeMenu = () => {
        menuToggle.setAttribute('aria-expanded', 'false');
        menuToggle.setAttribute('aria-label', 'Открыть меню');
        siteNav.classList.remove('is-open');
        document.body.classList.remove('menu-open');
    };

    menuToggle.addEventListener('click', () => {
        const willOpen = menuToggle.getAttribute('aria-expanded') !== 'true';
        menuToggle.setAttribute('aria-expanded', String(willOpen));
        menuToggle.setAttribute('aria-label', willOpen ? 'Закрыть меню' : 'Открыть меню');
        siteNav.classList.toggle('is-open', willOpen);
        document.body.classList.toggle('menu-open', willOpen);
    });

    siteNav.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
    window.addEventListener('resize', () => {
        if (window.innerWidth > 900) closeMenu();
    });

    // Scroll reveals
    const revealItems = document.querySelectorAll('.reveal');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduceMotion || !('IntersectionObserver' in window)) {
        revealItems.forEach((item) => item.classList.add('is-visible'));
    } else {
        const revealObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                const delay = Number(entry.target.dataset.delay || 0);
                entry.target.style.transitionDelay = `${delay}ms`;
                entry.target.classList.add('is-visible');
                observer.unobserve(entry.target);
            });
        }, { threshold: 0.12, rootMargin: '0px 0px -45px' });

        revealItems.forEach((item) => revealObserver.observe(item));
    }

    // Before / after comparison
    const comparison = document.getElementById('comparison');
    const compareRange = document.getElementById('compareRange');

    compareRange.addEventListener('input', () => {
        comparison.style.setProperty('--position', `${compareRange.value}%`);
    });

    // Interactive Yandex map, loaded when the contacts section is near the viewport
    const studioMap = document.getElementById('studioMap');
    if (studioMap) {
        const loadMap = () => {
            if (studioMap.dataset.loaded === 'true') return;
            const iframe = document.createElement('iframe');
            iframe.src = studioMap.dataset.mapSrc;
            iframe.title = 'Яндекс Карта — Siberian Detailing, Новосибирск, Ельцовская, 8В';
            iframe.loading = 'eager';
            iframe.allowFullscreen = true;
            studioMap.dataset.loaded = 'true';
            studioMap.replaceChildren(iframe);
        };

        loadMap();
    }

    // Calculator
    const serviceChecks = [...document.querySelectorAll('.service-check')];
    const vehicleInputs = [...document.querySelectorAll('input[name="vehicle"]')];
    const serviceButtons = document.querySelectorAll('.service-add');
    const summaryEmpty = document.getElementById('summaryEmpty');
    const summaryList = document.getElementById('summaryList');
    const durationValue = document.getElementById('durationValue');
    const finalTotal = document.getElementById('finalTotal');
    const calculatorBooking = document.getElementById('calculatorBooking');
    const selectedOrder = document.getElementById('selectedOrder');
    const selectedOrderText = document.getElementById('selectedOrderText');
    const bookingTotal = document.getElementById('bookingTotal');
    const clientService = document.getElementById('clientService');
    let calculatedTotal = 0;
    let selectedCalculatorServices = [];

    const getVehicleSurcharge = () => Number(document.querySelector('input[name="vehicle"]:checked')?.value || 0);
    const getVehicleClass = () => document.querySelector('input[name="vehicle"]:checked')?.dataset.id || 'sedan';

    const getSelectedServices = () => serviceChecks
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => ({
            id: checkbox.dataset.id,
            name: checkbox.dataset.name,
            price: Number(checkbox.dataset.price),
            group: checkbox.dataset.group || '',
            vehicleSurcharge: checkbox.dataset.vehicleSurcharge === 'true',
            isFrom: checkbox.dataset.from === 'true'
        }));

    const updateCalculator = () => {
        selectedCalculatorServices = getSelectedServices();
        const tintSurcharge = getVehicleSurcharge();
        calculatedTotal = selectedCalculatorServices.reduce((sum, service) => (
            sum + service.price + (service.vehicleSurcharge ? tintSurcharge : 0)
        ), 0);

        summaryList.replaceChildren();
        selectedCalculatorServices.forEach((service) => {
            const item = document.createElement('li');
            const name = document.createElement('span');
            const price = document.createElement('b');
            name.textContent = service.name;
            const serviceTotal = service.price + (service.vehicleSurcharge ? tintSurcharge : 0);
            price.textContent = `${service.isFrom ? 'от ' : ''}${money.format(serviceTotal)} ₽`;
            item.append(name, price);
            summaryList.append(item);
        });

        summaryEmpty.hidden = selectedCalculatorServices.length > 0;
        durationValue.textContent = tintSurcharge ? '+100 ₽ к выбранной тонировке' : 'базовая цена';
        finalTotal.textContent = money.format(calculatedTotal);

        const hasServices = selectedCalculatorServices.length > 0;
        calculatorBooking.classList.toggle('is-disabled', !hasServices);
        calculatorBooking.setAttribute('aria-disabled', String(!hasServices));
        selectedOrder.hidden = !hasServices;
        selectedOrderText.textContent = selectedCalculatorServices.map((service) => service.name).join(', ');
        bookingTotal.textContent = money.format(calculatedTotal);

        if (hasServices) {
            const firstService = selectedCalculatorServices[0].name;
            const hasOption = [...clientService.options].some((option) => option.value === firstService || option.textContent === firstService);
            if (hasOption) clientService.value = firstService;
        }
    };

    serviceChecks.forEach((checkbox) => checkbox.addEventListener('change', () => {
        if (checkbox.checked && checkbox.dataset.group) {
            serviceChecks.forEach((other) => {
                if (other !== checkbox && other.dataset.group === checkbox.dataset.group) other.checked = false;
            });
        }
        updateCalculator();
    }));
    vehicleInputs.forEach((input) => input.addEventListener('change', updateCalculator));

    serviceButtons.forEach((button) => {
        button.addEventListener('click', () => {
            const checkbox = document.querySelector(`.service-check[data-id="${button.dataset.service}"]`);
            if (checkbox) {
                checkbox.checked = true;
                if (checkbox.dataset.group) {
                    serviceChecks.forEach((other) => {
                        if (other !== checkbox && other.dataset.group === checkbox.dataset.group) other.checked = false;
                    });
                }
            }
            updateCalculator();
            document.getElementById('calculator').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
        });
    });

    calculatorBooking.addEventListener('click', (event) => {
        if (calculatorBooking.getAttribute('aria-disabled') === 'true') event.preventDefault();
    });

    updateCalculator();

    apiRequest('/api/config').then((config) => {
        const serviceOptions = [new Option('Выберите услугу', '')];
        config.services?.forEach((service) => serviceOptions.push(new Option(service.name, service.name)));
        serviceOptions.push(new Option('Нужна консультация', 'Нужна консультация'));
        clientService.replaceChildren(...serviceOptions);
        config.services?.forEach((service) => {
            const checkbox = document.querySelector(`.service-check[data-id="${service.id}"]`);
            if (!checkbox) return;
            checkbox.dataset.name = service.name;
            checkbox.dataset.price = service.price;
            checkbox.dataset.group = service.group || '';
            checkbox.dataset.vehicleSurcharge = String(Boolean(service.vehicleSurcharge));
            checkbox.dataset.from = String(Boolean(service.isFrom));
        });
        config.vehicles?.forEach((vehicle) => {
            const input = document.querySelector(`input[name="vehicle"][data-id="${vehicle.id}"]`);
            if (input) input.value = vehicle.tintSurcharge;
        });
        if (config.businessDate) bookingDate.min = config.businessDate;
        if (config.bookingMaxDate) bookingDate.max = config.bookingMaxDate;
        updateCalculator();
    }).catch(() => {
        // Статические значения остаются рабочим резервом, если конфигурация временно недоступна.
    });

    // Booking date and time
    const bookingDate = document.getElementById('bookingDate');
    const timeSlots = document.getElementById('timeSlots');
    const timeError = document.getElementById('timeError');
    let selectedTime = '';

    const today = new Date();
    const maxDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 90);
    bookingDate.min = getLocalDateKey(today);
    bookingDate.max = getLocalDateKey(maxDate);

    let slotsRequestController = null;

    const showSlotsMessage = (text) => {
        timeSlots.replaceChildren();
        const message = document.createElement('p');
        message.textContent = text;
        timeSlots.append(message);
    };

    const renderTimeSlots = async () => {
        selectedTime = '';
        timeError.textContent = '';
        slotsRequestController?.abort();

        if (!bookingDate.value) {
            showSlotsMessage('Сначала выберите дату');
            return;
        }

        const requestedDate = bookingDate.value;
        slotsRequestController = new AbortController();
        showSlotsMessage('Загружаем свободное время…');

        let freeSlots;
        try {
            const result = await apiRequest(`/api/slots?date=${encodeURIComponent(requestedDate)}`, {
                signal: slotsRequestController.signal
            });
            if (bookingDate.value !== requestedDate) return;
            freeSlots = result.slots || [];
        } catch (error) {
            if (error.name === 'AbortError') return;
            showSlotsMessage('Не удалось загрузить расписание');
            timeError.textContent = 'Проверьте соединение и попробуйте снова';
            return;
        }

        timeSlots.replaceChildren();

        if (!freeSlots.length) {
            showSlotsMessage('На этот день свободного времени нет');
            return;
        }

        freeSlots.forEach((time) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'time-slot';
            button.textContent = time;
            button.addEventListener('click', () => {
                timeSlots.querySelectorAll('.time-slot').forEach((slot) => slot.classList.remove('is-selected'));
                button.classList.add('is-selected');
                selectedTime = time;
                timeError.textContent = '';
            });
            timeSlots.append(button);
        });
    };

    bookingDate.addEventListener('change', renderTimeSlots);

    // Phone mask
    const clientPhone = document.getElementById('clientPhone');
    clientPhone.addEventListener('input', () => {
        let digits = clientPhone.value.replace(/\D/g, '').slice(0, 11);
        if (digits.startsWith('8')) digits = `7${digits.slice(1)}`;
        if (digits && !digits.startsWith('7')) digits = `7${digits}`.slice(0, 11);

        const local = digits.slice(1);
        let formatted = digits ? '+7' : '';
        if (local.length) formatted += ` (${local.slice(0, 3)}`;
        if (local.length >= 3) formatted += ')';
        if (local.length > 3) formatted += ` ${local.slice(3, 6)}`;
        if (local.length > 6) formatted += `-${local.slice(6, 8)}`;
        if (local.length > 8) formatted += `-${local.slice(8, 10)}`;
        clientPhone.value = formatted;
    });

    // Form validation and submission
    const bookingForm = document.getElementById('bookingForm');
    const clientName = document.getElementById('clientName');
    const clientCar = document.getElementById('clientCar');
    const clientComment = document.getElementById('clientComment');
    const privacyConsent = document.getElementById('privacyConsent');
    const formStatus = document.getElementById('formStatus');
    const submitButton = bookingForm.querySelector('button[type="submit"]');

    const setFieldError = (field, message) => {
        const wrapper = field.closest('.field');
        if (!wrapper) return;
        wrapper.classList.toggle('has-error', Boolean(message));
        const error = wrapper.querySelector('.field-error');
        if (error) error.textContent = message;
    };

    const clearErrors = () => {
        bookingForm.querySelectorAll('.field').forEach((field) => field.classList.remove('has-error'));
        bookingForm.querySelectorAll('.field-error').forEach((error) => { error.textContent = ''; });
        formStatus.textContent = '';
    };

    const validateBooking = () => {
        clearErrors();
        let firstInvalid = null;
        const mark = (field, message) => {
            setFieldError(field, message);
            if (!firstInvalid) firstInvalid = field;
        };

        if (clientName.value.trim().length < 2) mark(clientName, 'Укажите имя');
        if (clientPhone.value.replace(/\D/g, '').length !== 11) mark(clientPhone, 'Введите полный номер');
        if (!clientService.value) mark(clientService, 'Выберите услугу');
        if (!bookingDate.value) mark(bookingDate, 'Выберите дату');
        if (!selectedTime) {
            timeError.textContent = 'Выберите время';
            if (!firstInvalid) firstInvalid = bookingDate;
        }
        if (!privacyConsent.checked) {
            formStatus.textContent = 'Подтвердите согласие на обработку данных';
            if (!firstInvalid) firstInvalid = privacyConsent;
        }

        if (firstInvalid) firstInvalid.focus();
        return !firstInvalid;
    };

    bookingForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!validateBooking()) return;

        const booking = {
            name: clientName.value.trim(),
            phone: clientPhone.value,
            car: clientCar.value.trim(),
            primaryService: clientService.value,
            serviceIds: selectedCalculatorServices.map((service) => service.id),
            vehicleClass: getVehicleClass(),
            date: bookingDate.value,
            time: selectedTime,
            comment: clientComment.value.trim()
        };

        const originalButtonText = submitButton.innerHTML;
        submitButton.disabled = true;
        submitButton.textContent = 'Отправляем…';
        formStatus.textContent = '';

        try {
            await apiRequest('/api/bookings', {
                method: 'POST',
                body: JSON.stringify(booking)
            });
        } catch (error) {
            if (error.status === 409) {
                formStatus.textContent = 'Этот интервал только что заняли. Выберите другое время.';
                await renderTimeSlots();
            } else {
                formStatus.textContent = error.message || 'Не удалось отправить заявку. Позвоните нам, пожалуйста.';
            }
            submitButton.disabled = false;
            submitButton.innerHTML = originalButtonText;
            return;
        }

        const displayDate = new Date(`${booking.date}T12:00:00`).toLocaleDateString('ru-RU', {
            day: 'numeric',
            month: 'long'
        });
        document.getElementById('successDetails').textContent = `${booking.name}, ждём вас ${displayDate} в ${booking.time}. Администратор свяжется с вами для подтверждения.`;
        openModal(document.getElementById('successModal'));

        bookingForm.reset();
        selectedTime = '';
        selectedOrder.hidden = selectedCalculatorServices.length === 0;
        submitButton.disabled = false;
        submitButton.innerHTML = originalButtonText;
        await renderTimeSlots();
    });

    // Modals
    let modalTrigger = null;

    function openModal(modal) {
        modalTrigger = document.activeElement;
        modal.hidden = false;
        document.body.classList.add('modal-open');
        modal.querySelector('.modal-close')?.focus();
    }

    function closeModal(modal) {
        modal.hidden = true;
        if (![...document.querySelectorAll('.modal')].some((item) => !item.hidden)) {
            document.body.classList.remove('modal-open');
        }
        modalTrigger?.focus();
    }

    const successModal = document.getElementById('successModal');
    successModal.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => closeModal(successModal)));

    const privacyModal = document.getElementById('privacyModal');
    document.getElementById('privacyOpen').addEventListener('click', () => openModal(privacyModal));
    privacyModal.querySelectorAll('[data-close-privacy]').forEach((button) => button.addEventListener('click', () => closeModal(privacyModal)));

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (!successModal.hidden) closeModal(successModal);
        if (!privacyModal.hidden) closeModal(privacyModal);
        if (siteNav.classList.contains('is-open')) closeMenu();
    });
});
