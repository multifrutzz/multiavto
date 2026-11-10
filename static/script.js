// Общие функции для запросов, карточек и сообщений об ошибках.
async function requestJSON(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetch(url, {
            ...options,
            headers: { "Content-Type": "application/json" },
            signal: controller.signal
        });

        const data = await response.json();

        if (!response.ok) {
            const error = new Error(data.detail || "Не удалось выполнить запрос.");
            error.status = response.status;
            error.fields = data.errors || {};
            throw error;
        }

        return data;
    } catch (error) {
        if (error.status) throw error;

        throw new Error(
            "Сервер недоступен. Проверьте подключение и повторите попытку."
        );
    } finally {
        clearTimeout(timeout);
    }
}

function element(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
}

function formatNumber(value) {
    return Number(value).toLocaleString("ru-RU");
}

function showFieldError(field, message) {
    document.getElementById(field.id + "-error").textContent = message;
    field.setAttribute("aria-invalid", String(message !== ""));
}

function showServerErrors(form, error) {
    for (const [name, message] of Object.entries(error.fields || {})) {
        const field = form.elements.namedItem(name);
        if (field) showFieldError(field, message);
    }

    form.querySelector('[aria-invalid="true"]')?.focus();
}

function validateNumber(field, min, max, message) {
    const value = Number(field.value);
    const invalid = field.validity.badInput || (field.value !== "" &&
        (!Number.isSafeInteger(value) || value < min || value > max));

    showFieldError(field, invalid ? message : "");
    return !invalid;
}

async function addToComparison(carId, button, status) {
    button.disabled = true;
    status.textContent = "Добавляем автомобиль…";

    try {
        const data = await requestJSON("/api/comparison", {
            method: "POST",
            body: JSON.stringify({ car_id: carId })
        });

        status.textContent = data.message;
        button.textContent = "Добавлено в сравнение";
    } catch (error) {
        status.textContent = error.status === 401
            ? "Для сравнения войдите через «Личный кабинет»."
            : error.message;

        button.disabled = false;
    }
}

function createCarCard(car, withComparison = false) {
    const card = element("article");
    card.className = "car-card";
    card.dataset.price = car.price;
    card.dataset.year = car.year;
    card.dataset.mileage = car.mileage;

    const photo = element("img");
    photo.src = car.image;
    photo.alt = car.image_alt;
    photo.loading = "lazy";

    const link = element("a", "Подробнее");
    link.href = "car.html?id=" + car.id;

    const converted = element("p");
    converted.className = "converted-price";
    converted.hidden = true;

    card.append(
        photo,
        element("h3", car.name),
        element("p", car.year + " год · " + formatNumber(car.mileage) + " км"),
        element("p", formatNumber(car.price) + " ₽"),
        converted,
        link
    );

    if (withComparison) {
        const button = element("button", "Добавить в сравнение");
        button.type = "button";

        const status = element("p");
        status.setAttribute("role", "status");

        button.addEventListener("click", () => {
            addToComparison(car.id, button, status);
        });

        card.append(button, status);
    }

    return card;
}

async function loadHome() {
    const status = document.getElementById("home-status");

    try {
        const cars = await requestJSON("/api/cars");

        document.getElementById("home-list").replaceChildren(
            ...cars.slice(0, 6).map(car => createCarCard(car))
        );

        status.textContent = cars.length ? "" : "Автомобилей пока нет.";
    } catch (error) {
        status.textContent = error.message;
    }
}

async function setupCatalog() {
    const form = document.getElementById("filter-form");
    const priceField = document.getElementById("max-price");
    const yearField = document.getElementById("min-year");
    const mileageField = document.getElementById("max-mileage");
    const sortField = document.getElementById("sort");
    const list = document.getElementById("catalog-list");
    const status = document.getElementById("catalog-status");

    form.addEventListener("submit", event => event.preventDefault());

    const controls = [...form.querySelectorAll("input, select, button")];
    const reload = document.getElementById("reload-catalog");
    const rateButtonBeforeLoad = document.getElementById("reload-rates");

    controls.forEach(control => { control.disabled = true; });
    rateButtonBeforeLoad.disabled = true;

    let cars;

    try {
        cars = await requestJSON("/api/cars");
    } catch (error) {
        status.textContent = error.message;
        reload.hidden = false;
        reload.onclick = () => location.reload();
        return;
    }

    list.replaceChildren(...cars.map(car => createCarCard(car, true)));

    const cards = Array.from(list.querySelectorAll(".car-card"));
    let visibleCards = cards.slice();
    const currentYear = new Date().getFullYear();
    yearField.max = currentYear;

    function showCars() {
        // Копия сохраняет исходный порядок карточек.
        const sortedCards = visibleCards.slice();

        if (sortField.value === "price-asc") {
            sortedCards.sort((a, b) => {
                return Number(a.dataset.price) - Number(b.dataset.price);
            });
        } else if (sortField.value === "year-desc") {
            sortedCards.sort((a, b) => {
                return Number(b.dataset.year) - Number(a.dataset.year);
            });
        }

        for (const card of cards) {
            card.hidden = true;
        }

        for (const card of sortedCards) {
            card.hidden = false;
            list.append(card);
        }

        status.textContent = sortedCards.length === 0
            ? "По заданным условиям автомобили не найдены. Попробуйте изменить фильтры."
            : "Найдено автомобилей: " + sortedCards.length +
              " из " + cards.length + ".";
    }

    form.addEventListener("submit", function (event) {
        event.preventDefault();

        const priceValid = validateNumber(
            priceField, 0, Number.MAX_SAFE_INTEGER,
            "Введите целую неотрицательную цену."
        );

        const yearValid = validateNumber(
            yearField, 1900, currentYear,
            "Введите целый год от 1900 до " + currentYear + "."
        );

        const mileageValid = validateNumber(
            mileageField, 0, Number.MAX_SAFE_INTEGER,
            "Введите целый неотрицательный пробег."
        );

        if (!priceValid || !yearValid || !mileageValid) {
            form.querySelector('[aria-invalid="true"]').focus();
            return;
        }

        visibleCards = cards.filter(function (card) {
            return (
                (priceField.value === "" ||
                    Number(card.dataset.price) <= Number(priceField.value)) &&
                (yearField.value === "" ||
                    Number(card.dataset.year) >= Number(yearField.value)) &&
                (mileageField.value === "" ||
                    Number(card.dataset.mileage) <= Number(mileageField.value))
            );
        });

        showCars();
    });

    sortField.addEventListener("change", showCars);

    form.addEventListener("reset", function () {
        for (const field of [priceField, yearField, mileageField]) {
            showFieldError(field, "");
        }

        sortField.value = "default";
        visibleCards = cards.slice();
        showCars();
    });

    const rateStatus = document.getElementById("rates-status");
    const rateButton = document.getElementById("reload-rates");

    const dollars = new Intl.NumberFormat("ru-RU", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0
    });

    async function loadExchangeRate() {
        rateButton.disabled = true;
        rateStatus.textContent = "Загружаем курс доллара…";

        for (const card of cards) {
            card.querySelector(".converted-price").hidden = true;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        try {
            const response = await fetch(
                "https://www.cbr-xml-daily.ru/daily_json.js",
                {
                    cache: "no-store",
                    signal: controller.signal
                }
            );

            if (!response.ok) {
                throw new Error("Не удалось получить курсы валют");
            }

            const data = await response.json();
            const usd = data.Valute.USD;
            const rate = usd.Value / usd.Nominal;
            const date = new Date(data.Date);

            if (
                !Number.isFinite(usd.Value) || usd.Value <= 0 ||
                !Number.isFinite(usd.Nominal) || usd.Nominal <= 0 ||
                !Number.isFinite(rate) || rate <= 0 ||
                typeof data.Date !== "string" || Number.isNaN(date.getTime())
            ) {
                throw new Error("Источник вернул неверные данные");
            }

            rateStatus.textContent =
                "Курс на " + date.toLocaleDateString("ru-RU") +
                ": 1 USD = " +
                rate.toLocaleString("ru-RU", { maximumFractionDigits: 4 }) +
                " ₽.";

            for (const card of cards) {
                const convertedPrice = card.querySelector(".converted-price");

                convertedPrice.textContent = "≈ " +
                    dollars.format(Number(card.dataset.price) / rate);

                convertedPrice.hidden = false;
            }
        } catch (error) {
            rateStatus.textContent =
                "Не удалось загрузить курс. Проверьте подключение к интернету " +
                "и нажмите «Обновить курс». Цены в рублях по-прежнему доступны.";
        } finally {
            clearTimeout(timeout);
            setTimeout(() => { rateButton.disabled = false; }, 1000);
        }
    }

    rateButton.addEventListener("click", loadExchangeRate);
    showCars();
    controls.forEach(control => { control.disabled = false; });
    loadExchangeRate();
}

async function loadCar() {
    const status = document.getElementById("car-status");
    const id = Number(new URLSearchParams(location.search).get("id"));

    if (!Number.isSafeInteger(id) || id < 1) {
        status.textContent = "Указан неверный идентификатор автомобиля.";
        return;
    }

    try {
        const car = await requestJSON("/api/cars/" + id);

        document.title = car.name + " - multiavto";
        document.getElementById("car-title").textContent = car.name;

        const photo = document.getElementById("car-photo");
        photo.src = car.image;
        photo.alt = car.image_alt;

        document.getElementById("car-description").textContent = car.description;
        document.getElementById("car-price").textContent =
            "Цена: " + formatNumber(car.price) + " ₽";

        document.getElementById("car-specs").replaceChildren(
            element("li", "Год выпуска: " + car.year),
            element("li", "Пробег: " + formatNumber(car.mileage) + " км"),
            element("li", "Кузов: " + car.body)
        );

        document.getElementById("car-gallery").replaceChildren(
            ...car.gallery.map(image => {
                const img = element("img");
                img.src = image.src;
                img.alt = image.alt;
                return img;
            })
        );

        const button = document.getElementById("car-compare");

        button.addEventListener("click", () => {
            addToComparison(
                car.id,
                button,
                document.getElementById("car-action-status")
            );
        });

        document.getElementById("car-detail").hidden = false;
        status.textContent = "";
    } catch (error) {
        status.textContent = error.message;
    }
}

async function loadComparison() {
    const status = document.getElementById("comparison-status");
    const content = document.getElementById("comparison-content");
    status.textContent = "Загружаем сравнение…";

    try {
        const cars = await requestJSON("/api/comparison");
        const header = element("tr");

        for (const text of [
            "Автомобиль", "Год", "Пробег, км", "Кузов", "Цена, ₽", "Действие"
        ]) {
            const cell = element("th", text);
            cell.scope = "col";
            header.append(cell);
        }

        document.getElementById("comparison-head").replaceChildren(header);

        document.getElementById("comparison-body").replaceChildren(
            ...cars.map(car => {
                const row = element("tr");
                const name = element("th");
                name.scope = "row";

                const link = element("a", car.name);
                link.href = "car.html?id=" + car.id;
                name.append(link);

                row.append(
                    name,
                    element("td", car.year),
                    element("td", formatNumber(car.mileage)),
                    element("td", car.body),
                    element("td", formatNumber(car.price))
                );

                const action = element("td");
                const button = element("button", "Убрать");
                button.type = "button";

                button.addEventListener("click", async () => {
                    button.disabled = true;

                    try {
                        await requestJSON(
                            "/api/comparison/" + car.id,
                            { method: "DELETE" }
                        );
                        await loadComparison();
                    } catch (error) {
                        status.textContent = error.message;
                        button.disabled = false;
                    }
                });

                action.append(button);
                row.append(action);
                return row;
            })
        );

        content.hidden = cars.length === 0;

        status.textContent = cars.length
            ? "Выбрано автомобилей: " + cars.length + "."
            : "Список пуст. Добавьте автомобили из каталога.";
    } catch (error) {
        content.hidden = true;
        status.textContent = error.message;

        document.getElementById("comparison-login").hidden =
            error.status !== 401;
    }
}

function setupContactForm() {
    const form = document.getElementById("contact-form");
    const nameField = form.elements.name;
    const emailField = form.elements.email;
    const messageField = form.elements.message;
    const result = document.getElementById("contact-result");
    const button = form.querySelector("button");

    form.addEventListener("submit", async event => {
        event.preventDefault();

        const name = nameField.value.trim();
        const email = emailField.value.trim();
        const message = messageField.value.trim();

        showFieldError(
            nameField,
            name.length < 2 || name.length > 80
                ? "Введите имя длиной от 2 до 80 символов." : ""
        );

        showFieldError(
            emailField,
            !email || emailField.validity.typeMismatch || email.length > 254
                ? "Введите корректную электронную почту." : ""
        );

        showFieldError(
            messageField,
            message.length < 10 || message.length > 2000
                ? "Введите сообщение длиной от 10 до 2000 символов." : ""
        );

        result.hidden = true;

        const invalid = form.querySelector('[aria-invalid="true"]');

        if (invalid) {
            invalid.focus();
            return;
        }

        button.disabled = true;
        result.hidden = false;
        result.textContent = "Отправляем сообщение…";

        try {
            const data = await requestJSON("/api/messages", {
                method: "POST",
                body: JSON.stringify({ name, email, message })
            });

            result.textContent = data.message;
            form.reset();
        } catch (error) {
            result.textContent = error.message;
            showServerErrors(form, error);
        } finally {
            button.disabled = false;
        }
    });

    form.addEventListener("input", () => { result.hidden = true; });
}

async function loadProfile() {
    const status = document.getElementById("account-status");
    const profile = document.getElementById("profile");
    const forms = document.getElementById("account-forms");

    try {
        const user = await requestJSON("/api/me");

        document.getElementById("profile-name").textContent =
            "Имя: " + user.name;
        document.getElementById("profile-email").textContent =
            "Почта: " + user.email;

        profile.hidden = false;
        forms.hidden = true;
        status.textContent = "Вы вошли в аккаунт.";
    } catch (error) {
        profile.hidden = true;
        forms.hidden = false;

        status.textContent = error.status === 401
            ? "Войдите или создайте аккаунт." : error.message;
    }
}

function setupAuthForm(prefix) {
    const form = document.getElementById(prefix + "-form");
    const result = document.getElementById(prefix + "-result");
    const button = form.querySelector("button");

    form.addEventListener("submit", async event => {
        event.preventDefault();
        result.textContent = "";

        const data = {};

        for (const field of form.querySelectorAll("input")) {
            const value = field.type === "password"
                ? field.value : field.value.trim();

            data[field.name] = value;
            let message = "";

            if (field.name === "name" &&
                (value.length < 2 || value.length > 80)) {
                message = "Введите имя длиной от 2 до 80 символов.";
            } else if (field.name === "email" &&
                (!value || field.validity.typeMismatch || value.length > 254)) {
                message = "Введите корректную электронную почту.";
            } else if (field.name === "password" &&
                (value.length < 8 || value.length > 128)) {
                message = "Пароль должен содержать от 8 до 128 символов.";
            }

            showFieldError(field, message);
        }

        const invalid = form.querySelector('[aria-invalid="true"]');

        if (invalid) {
            invalid.focus();
            return;
        }

        button.disabled = true;
        result.textContent = "Отправляем данные…";

        try {
            const response = await requestJSON("/api/" + prefix, {
                method: "POST",
                body: JSON.stringify(data)
            });

            result.textContent = response.message;
            form.elements.password.value = "";

            if (prefix === "login") {
                await loadProfile();
            } else {
                document.getElementById("login-email").value = data.email;
            }
        } catch (error) {
            result.textContent = error.message;
            showServerErrors(form, error);
        } finally {
            button.disabled = false;
        }
    });

    form.addEventListener("input", () => { result.textContent = ""; });
}

function setupAccount() {
    setupAuthForm("register");
    setupAuthForm("login");

    document.getElementById("logout").addEventListener("click", async event => {
        const button = event.currentTarget;
        button.disabled = true;

        try {
            await requestJSON("/api/logout", { method: "POST" });
            await loadProfile();
        } catch (error) {
            document.getElementById("account-status").textContent =
                error.message;
        } finally {
            button.disabled = false;
        }
    });

    loadProfile();
}

if (document.getElementById("home-list")) loadHome();
if (document.getElementById("filter-form")) setupCatalog();
if (document.getElementById("car-detail")) loadCar();
if (document.getElementById("comparison-content")) loadComparison();
if (document.getElementById("contact-form")) setupContactForm();
if (document.getElementById("account-forms")) setupAccount();