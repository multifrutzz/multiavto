import hashlib
import json
import os
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi import Path as ApiPath
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field, field_validator
from pwdlib import PasswordHash


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv("DATABASE_PATH", str(BASE_DIR / "data" / "multiavto.db")))
PASSWORD_HASH = PasswordHash.recommended()
SESSION_SECONDS = 24 * 60 * 60
COOKIE_NAME = "multiavto_session"
MAX_CAR_ID = 2**63 - 1


@contextmanager
def database():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def init_database():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with database() as db:
        db.executescript((BASE_DIR / "schema.sql").read_text(encoding="utf-8"))

        if db.execute("SELECT COUNT(*) FROM cars").fetchone()[0] == 0:
            cars = json.loads(
                (BASE_DIR / "cars.json").read_text(encoding="utf-8")
            )

            for car in cars:
                db.execute(
                    """INSERT INTO cars
                    (id, name, year, mileage, body, price, description,
                     image, image_alt, gallery)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        car["id"],
                        car["name"],
                        car["year"],
                        car["mileage"],
                        car["body"],
                        car["price"],
                        car["description"],
                        car["image"],
                        car["image_alt"],
                        json.dumps(car["gallery"], ensure_ascii=False),
                    ),
                )


@asynccontextmanager
async def lifespan(app):
    init_database()
    yield


app = FastAPI(title="multiavto", lifespan=lifespan)


class RegisterData(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    email: EmailStr = Field(max_length=254)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("name", "email", mode="before")
    @classmethod
    def strip_spaces(cls, value):
        return value.strip() if isinstance(value, str) else value


class LoginData(BaseModel):
    email: EmailStr = Field(max_length=254)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("email", mode="before")
    @classmethod
    def strip_spaces(cls, value):
        return value.strip() if isinstance(value, str) else value


class ComparisonData(BaseModel):
    car_id: int = Field(gt=0, le=MAX_CAR_ID, strict=True)


class MessageData(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    email: EmailStr = Field(max_length=254)
    message: str = Field(min_length=10, max_length=2000)

    @field_validator("name", "email", "message", mode="before")
    @classmethod
    def strip_spaces(cls, value):
        return value.strip() if isinstance(value, str) else value


@app.exception_handler(RequestValidationError)
async def validation_error(request, error):
    messages = {
        "name": "Введите имя длиной от 2 до 80 символов.",
        "email": "Введите корректную электронную почту длиной до 254 символов.",
        "password": "Пароль должен содержать от 8 до 128 символов.",
        "message": "Введите сообщение длиной от 10 до 2000 символов.",
        "car_id": "Укажите целый ID автомобиля от 1 до " + str(MAX_CAR_ID) + ".",
    }

    errors = {}
    for item in error.errors():
        field = str(item["loc"][-1])
        errors[field] = messages.get(field, "Проверьте значение поля.")

    return JSONResponse(
        status_code=422,
        content={
            "detail": "Проверьте введённые данные.",
            "errors": errors,
        },
    )


def car_data(row):
    car = dict(row)
    car["gallery"] = json.loads(car["gallery"])
    return car


def get_current_user(request: Request):
    token = request.cookies.get(COOKIE_NAME)

    if not token:
        raise HTTPException(401, "Сначала войдите в личный кабинет.")

    token_hash = hashlib.sha256(token.encode()).hexdigest()

    with database() as db:
        user = db.execute(
            """SELECT users.id, users.name, users.email FROM users
            JOIN sessions ON sessions.user_id = users.id
            WHERE sessions.token_hash = ? AND sessions.expires_at > ?""",
            (token_hash, int(time.time())),
        ).fetchone()

    if user is None:
        raise HTTPException(401, "Сессия завершена. Войдите снова.")

    return dict(user)


@app.get("/api/cars")
def list_cars():
    with database() as db:
        rows = db.execute("SELECT * FROM cars ORDER BY id").fetchall()

    return [car_data(row) for row in rows]


@app.get("/api/cars/{car_id}")
def get_car(car_id: int = ApiPath(ge=1, le=MAX_CAR_ID)):
    with database() as db:
        row = db.execute(
            "SELECT * FROM cars WHERE id = ?",
            (car_id,),
        ).fetchone()

    if row is None:
        raise HTTPException(404, "Автомобиль не найден.")

    return car_data(row)


@app.post("/api/register", status_code=201)
def register(data: RegisterData):
    password_hash = PASSWORD_HASH.hash(data.password)

    try:
        with database() as db:
            db.execute(
                "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
                (data.name, str(data.email).lower(), password_hash),
            )
    except sqlite3.IntegrityError:
        return JSONResponse(
            status_code=409,
            content={
                "detail": "Эта почта уже зарегистрирована.",
                "errors": {"email": "Эта почта уже зарегистрирована."},
            },
        )

    return {"message": "Регистрация завершена. Теперь войдите в аккаунт."}


@app.post("/api/login")
def login(data: LoginData, response: Response):
    with database() as db:
        user = db.execute(
            "SELECT * FROM users WHERE email = ?",
            (str(data.email).lower(),),
        ).fetchone()

        if user is None or not PASSWORD_HASH.verify(
            data.password, user["password_hash"]
        ):
            raise HTTPException(401, "Неверная почта или пароль.")

        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        now = int(time.time())

        db.execute(
            "DELETE FROM sessions WHERE expires_at <= ?",
            (now,),
        )
        db.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (token_hash, user["id"], now + SESSION_SECONDS),
        )

    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=SESSION_SECONDS,
        httponly=True,
        samesite="strict",
        secure=os.getenv("COOKIE_SECURE", "0") == "1",
    )

    return {"message": "Вы вошли в аккаунт."}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE_NAME, "")

    with database() as db:
        db.execute(
            "DELETE FROM sessions WHERE token_hash = ?",
            (hashlib.sha256(token.encode()).hexdigest(),),
        )

    response.delete_cookie(COOKIE_NAME, samesite="strict")
    return {"message": "Вы вышли из аккаунта."}


@app.get("/api/me")
def profile(user=Depends(get_current_user)):
    return user


@app.get("/api/comparison")
def list_comparison(user=Depends(get_current_user)):
    with database() as db:
        rows = db.execute(
            """SELECT cars.* FROM cars
            JOIN comparisons ON comparisons.car_id = cars.id
            WHERE comparisons.user_id = ? ORDER BY cars.id""",
            (user["id"],),
        ).fetchall()

    return [car_data(row) for row in rows]


@app.post("/api/comparison", status_code=201)
def add_comparison(data: ComparisonData, user=Depends(get_current_user)):
    with database() as db:
        car = db.execute(
            "SELECT id FROM cars WHERE id = ?",
            (data.car_id,),
        ).fetchone()

        if car is None:
            raise HTTPException(404, "Автомобиль не найден.")

        db.execute(
            "INSERT OR IGNORE INTO comparisons (user_id, car_id) VALUES (?, ?)",
            (user["id"], data.car_id),
        )

    return {"message": "Автомобиль добавлен в ваше сравнение."}


@app.delete("/api/comparison/{car_id}")
def remove_comparison(
    car_id: int = ApiPath(ge=1, le=MAX_CAR_ID),
    user=Depends(get_current_user),
):
    with database() as db:
        result = db.execute(
            "DELETE FROM comparisons WHERE user_id = ? AND car_id = ?",
            (user["id"], car_id),
        )

        if result.rowcount == 0:
            raise HTTPException(404, "В вашем сравнении нет этого автомобиля.")

    return {"message": "Автомобиль удалён из сравнения."}


@app.post("/api/messages", status_code=201)
def save_message(data: MessageData):
    with database() as db:
        db.execute(
            "INSERT INTO messages (name, email, message) VALUES (?, ?, ?)",
            (data.name, str(data.email).lower(), data.message),
        )

    return {"message": "Сообщение сохранено. Спасибо за обращение!"}


# Публикуются только изображения и известные файлы страниц.
app.mount(
    "/images",
    StaticFiles(directory=BASE_DIR / "static" / "images"),
    name="images",
)


@app.get("/")
def home_page():
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/{filename}")
def static_file(filename: str):
    allowed = {
        "index.html",
        "catalog.html",
        "car.html",
        "comparison.html",
        "contacts.html",
        "account.html",
        "script.js",
        "style.css",
    }

    if filename not in allowed:
        raise HTTPException(404, "Страница не найдена.")

    return FileResponse(BASE_DIR / "static" / filename)