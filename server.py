import hashlib
import hmac
import json
import secrets
import sqlite3
import time
import uuid
from datetime import datetime
from email import policy
from email.parser import BytesParser
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse, urlsplit


ROOT = Path(__file__).resolve().parent
DATABASE = ROOT / "portal.sqlite3"
COURSE_FILES = ROOT.parent / ".northstar-course-materials"
MAX_PDF_BYTES = 15 * 1024 * 1024
SESSION_SECONDS = 60 * 60 * 24 * 7
PASSWORD_ITERATIONS = 310_000
ASSIGNMENTS = {
    "literature-review": ("Literature review outline", "Research Methods", "Dr. Chen", "TOMORROW"),
    "memory-quiz": ("Memory & attention quiz", "Cognitive Psychology", "Dr. Lee", "OCT 26"),
    "reflection-journal": ("Reflection journal · Week 7", "Social Psychology", "Dr. Patel", "OCT 29"),
}
COURSES = [
    {"title": "Cognitive Psychology", "code": "PSY 204", "instructor": "Dr. Lee", "progress": 68},
    {"title": "Research Methods", "code": "PSY 210", "instructor": "Prof. Chen", "progress": 42},
    {"title": "Social Psychology", "code": "PSY 230", "instructor": "Dr. Patel", "progress": 85},
    {"title": "Developmental Psychology", "code": "PSY 250", "instructor": "Dr. Morris", "progress": 24},
]
LESSON_TITLES = (
    "Course foundations",
    "Key ideas and vocabulary",
    "Putting concepts to work",
    "Case study and reflection",
    "Knowledge check",
)


def connect_database():
    connection = sqlite3.connect(DATABASE)
    connection.execute(
        "CREATE TABLE IF NOT EXISTS assignment_status "
        "(assignment_id TEXT PRIMARY KEY, completed INTEGER NOT NULL DEFAULT 0)"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS courses "
        "(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, code TEXT NOT NULL UNIQUE, instructor TEXT NOT NULL)"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS assignments "
        "(id TEXT PRIMARY KEY, title TEXT NOT NULL, course TEXT NOT NULL, instructor TEXT NOT NULL, due TEXT NOT NULL)"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS online_classes "
        "(id TEXT PRIMARY KEY, title TEXT NOT NULL, course TEXT NOT NULL, instructor TEXT NOT NULL, "
        "starts_at TEXT NOT NULL, meeting_url TEXT NOT NULL, created_at INTEGER NOT NULL)"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS course_progress "
        "(user_id INTEGER NOT NULL, course_code TEXT NOT NULL, lesson_index INTEGER NOT NULL, "
        "completed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, course_code, lesson_index), "
        "FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS course_materials "
        "(id TEXT PRIMARY KEY, course_code TEXT NOT NULL, original_name TEXT NOT NULL, "
        "stored_name TEXT NOT NULL UNIQUE, uploaded_by INTEGER NOT NULL, uploaded_at INTEGER NOT NULL, "
        "FOREIGN KEY(uploaded_by) REFERENCES users(id) ON DELETE CASCADE)"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS users "
        "(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, "
        "password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL)"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS sessions "
        "(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, "
        "FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)"
    )
    return connection


class PortalHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def current_user(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        session_cookie = cookie.get("northstar_session")
        if session_cookie is None:
            return None
        token_hash = hashlib.sha256(session_cookie.value.encode("utf-8")).hexdigest()
        now = int(time.time())
        with connect_database() as connection:
            row = connection.execute(
                "SELECT users.id, users.name, users.email, users.role "
                "FROM sessions JOIN users ON users.id = sessions.user_id "
                "WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
                (token_hash, now),
            ).fetchone()
            connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
        if row is None:
            return None
        return {"id": row[0], "name": row[1], "email": row[2], "role": row[3]}

    def require_user(self, roles=None):
        user = self.current_user()
        if user is None:
            self.send_json({"error": "Please sign in to continue"}, 401)
            return None
        if roles and user["role"] not in roles:
            self.send_json({"error": "Your account does not have access to this action"}, 403)
            return None
        return user

    def set_session(self, user_id):
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        expires_at = int(time.time()) + SESSION_SECONDS
        with connect_database() as connection:
            connection.execute(
                "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                (token_hash, user_id, expires_at),
            )
        return f"northstar_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_SECONDS}"

    def clear_session(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        session_cookie = cookie.get("northstar_session")
        if session_cookie is not None:
            token_hash = hashlib.sha256(session_cookie.value.encode("utf-8")).hexdigest()
            with connect_database() as connection:
                connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
        return "northstar_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"

    def send_session_json(self, payload, cookie, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/me":
            user = self.current_user()
            if user is None:
                self.send_json({"error": "Not signed in"}, 401)
            else:
                self.send_json({"user": user})
            return
        if path.startswith("/api/"):
            user = self.require_user({"student", "lecturer"})
            if user is None:
                return
            if path == "/api/admin/overview" and user["role"] != "lecturer":
                self.send_json({"error": "Lecturer access required"}, 403)
                return
            if path.startswith("/api/materials/"):
                self.get_material(path, user, parse_qs(urlparse(self.path).query))
                return
            if path.startswith("/api/courses/"):
                self.get_course(path, user)
                return
        if path == "/api/courses":
            with connect_database() as connection:
                added_courses = [
                    {"title": title, "code": code, "instructor": instructor, "progress": 0}
                    for title, code, instructor in connection.execute(
                        "SELECT title, code, instructor FROM courses ORDER BY id DESC"
                    )
                ]
            self.send_json(self.courses_with_progress(user, added_courses))
            return
        if path == "/api/admin/overview":
            with connect_database() as connection:
                added_courses = connection.execute("SELECT COUNT(*) FROM courses").fetchone()[0]
                added_assignments = connection.execute("SELECT COUNT(*) FROM assignments").fetchone()[0]
                completed = connection.execute(
                    "SELECT COUNT(*) FROM assignment_status WHERE completed = 1"
                ).fetchone()[0]
            self.send_json({
                "course_count": len(COURSES) + added_courses,
                "assignment_count": len(ASSIGNMENTS) + added_assignments,
                "completion_count": completed,
            })
            return
        if path == "/api/assignments":
            with connect_database() as connection:
                saved = dict(connection.execute(
                    "SELECT assignment_id, completed FROM assignment_status"
                ))
                added_assignments = connection.execute(
                    "SELECT id, title, course, instructor, due FROM assignments ORDER BY rowid DESC"
                ).fetchall()
            assignments = [
                {
                    "id": assignment_id,
                    "title": details[0],
                    "course": details[1],
                    "instructor": details[2],
                    "due": details[3],
                    "completed": bool(saved.get(assignment_id, 0)),
                }
                for assignment_id, details in ASSIGNMENTS.items()
            ]
            assignments.extend(
                {
                    "id": assignment_id,
                    "title": title,
                    "course": course,
                    "instructor": instructor,
                    "due": due,
                    "completed": bool(saved.get(assignment_id, 0)),
                }
                for assignment_id, title, course, instructor, due in added_assignments
            )
            self.send_json(assignments)
            return
        if path == "/api/classes":
            with connect_database() as connection:
                classes = connection.execute(
                    "SELECT id, title, course, instructor, starts_at, meeting_url "
                    "FROM online_classes ORDER BY starts_at"
                ).fetchall()
            self.send_json([
                {
                    "id": class_id,
                    "title": title,
                    "course": course,
                    "instructor": instructor,
                    "starts_at": starts_at,
                    "meeting_url": meeting_url,
                }
                for class_id, title, course, instructor, starts_at, meeting_url in classes
            ])
            return
        super().do_GET()

    def courses_with_progress(self, user, added_courses):
        courses = [dict(course) for course in COURSES] + added_courses
        with connect_database() as connection:
            for course in courses:
                saved = connection.execute(
                    "SELECT COUNT(*), SUM(completed) FROM course_progress "
                    "WHERE user_id = ? AND course_code = ?",
                    (user["id"], course["code"]),
                ).fetchone()
                if saved[0]:
                    course["progress"] = round((saved[1] or 0) / len(LESSON_TITLES) * 100)
        return courses

    def find_course(self, course_code):
        for course in COURSES:
            if course["code"] == course_code:
                return dict(course)
        with connect_database() as connection:
            row = connection.execute(
                "SELECT title, code, instructor FROM courses WHERE code = ?", (course_code,)
            ).fetchone()
        if row is None:
            return None
        return {"title": row[0], "code": row[1], "instructor": row[2], "progress": 0}

    def default_completed_count(self, course):
        return round(course.get("progress", 0) / 20)

    def get_course(self, path, user):
        course_code = unquote(path.removeprefix("/api/courses/")).strip("/")
        course = self.find_course(course_code)
        if course is None:
            self.send_json({"error": "Course not found"}, 404)
            return
        with connect_database() as connection:
            material_rows = connection.execute(
                "SELECT id, original_name, uploaded_at FROM course_materials "
                "WHERE course_code = ? ORDER BY uploaded_at DESC",
                (course_code,),
            ).fetchall()
        with connect_database() as connection:
            saved = connection.execute(
                "SELECT lesson_index, completed FROM course_progress "
                "WHERE user_id = ? AND course_code = ?",
                (user["id"], course_code),
            ).fetchall()
        progress = {index: bool(completed) for index, completed in saved}
        if not saved:
            default_count = self.default_completed_count(course)
            progress = {index: index < default_count for index in range(len(LESSON_TITLES))}
        lessons = [
            {
                "id": index,
                "title": title,
                "completed": progress.get(index, False),
                "content": self.lesson_content(course["title"], title, index),
            }
            for index, title in enumerate(LESSON_TITLES)
        ]
        completed_count = sum(lesson["completed"] for lesson in lessons)
        self.send_json({
            **course,
            "lessons": lessons,
            "materials": [
                {"id": row[0], "name": row[1], "uploaded_at": row[2], "download_url": f"/api/materials/{row[0]}"}
                for row in material_rows
            ],
            "completed_count": completed_count,
            "progress": round(completed_count / len(LESSON_TITLES) * 100),
        })

    def get_material(self, path, user, query):
        material_id = path.removeprefix("/api/materials/")
        with connect_database() as connection:
            row = connection.execute(
                "SELECT course_code, original_name, stored_name FROM course_materials WHERE id = ?",
                (material_id,),
            ).fetchone()
        if row is None:
            self.send_json({"error": "Course material not found"}, 404)
            return
        if self.find_course(row[0]) is None:
            self.send_json({"error": "Course not found"}, 404)
            return
        file_path = COURSE_FILES / row[2]
        if not file_path.is_file():
            self.send_json({"error": "Course material is unavailable"}, 404)
            return
        file_bytes = file_path.read_bytes()
        encoded_name = quote(row[1], safe="")
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(file_bytes)))
        disposition = "inline" if query.get("view") == ["1"] else "attachment"
        self.send_header("Content-Disposition", f"{disposition}; filename=course-material.pdf; filename*=UTF-8''{encoded_name}")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "private, no-store")
        self.end_headers()
        self.wfile.write(file_bytes)

    def save_course_material(self, course_code, user):
        course = self.find_course(course_code)
        if course is None:
            self.send_json({"error": "Choose an existing course"}, 404)
            return
        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("multipart/form-data"):
            self.send_json({"error": "Upload a PDF file"}, 400)
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json({"error": "Invalid upload size"}, 400)
            return
        if content_length <= 0 or content_length > MAX_PDF_BYTES + 65536:
            self.send_json({"error": "PDF must be smaller than 15 MB"}, 413)
            return
        body = self.rfile.read(content_length)
        message = BytesParser(policy=policy.default).parsebytes(
            b"Content-Type: " + content_type.encode("ascii", "replace")
            + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
        )
        upload = next((part for part in message.iter_parts() if part.get_param("name", header="content-disposition") == "file"), None)
        if upload is None or not upload.get_filename():
            self.send_json({"error": "Choose a PDF file to upload"}, 400)
            return
        original_name = Path(upload.get_filename().replace("\\", "/")).name
        original_name = "".join(character for character in original_name if character.isprintable()).strip()
        pdf_bytes = upload.get_payload(decode=True) or b""
        if len(pdf_bytes) > MAX_PDF_BYTES:
            self.send_json({"error": "PDF must be smaller than 15 MB"}, 413)
            return
        if Path(original_name).suffix.lower() != ".pdf" or upload.get_content_type() != "application/pdf" or not pdf_bytes.startswith(b"%PDF-"):
            self.send_json({"error": "Only valid PDF files can be uploaded"}, 415)
            return
        material_id = uuid.uuid4().hex
        stored_name = f"{material_id}.pdf"
        COURSE_FILES.mkdir(parents=True, exist_ok=True)
        (COURSE_FILES / stored_name).write_bytes(pdf_bytes)
        uploaded_at = int(time.time())
        try:
            with connect_database() as connection:
                connection.execute(
                    "INSERT INTO course_materials "
                    "(id, course_code, original_name, stored_name, uploaded_by, uploaded_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (material_id, course_code, original_name[:180], stored_name, user["id"], uploaded_at),
                )
        except sqlite3.Error:
            (COURSE_FILES / stored_name).unlink(missing_ok=True)
            raise
        self.send_json({
            "id": material_id,
            "course_code": course_code,
            "name": original_name[:180],
            "uploaded_at": uploaded_at,
            "download_url": f"/api/materials/{material_id}",
        }, 201)

    def lesson_content(self, course_title, lesson_title, lesson_index):
        descriptions = (
            f"Begin with the questions and themes that shape {course_title}. Connect the course goals to what you already know, then note one idea you want to investigate.",
            f"Build a clear working vocabulary for {course_title}. Compare the central concepts, identify where they overlap, and keep a short example for each.",
            f"Apply the ideas from {course_title} to a practical situation. Explain which concept helps you interpret it and what evidence would strengthen your explanation.",
            f"Consider a short scenario through the lens of {course_title}. Write a reflection that separates your observations from your assumptions and connects them to course concepts.",
            f"Review the main ideas from {course_title}. Summarize the most useful concept in your own words and identify what you would like to revisit next.",
        )
        return descriptions[lesson_index]

    def read_payload(self):
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length))
        if not isinstance(payload, dict):
            raise ValueError("Expected a JSON object")
        return payload

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/register":
            self.register_account()
            return
        if path == "/api/login":
            self.login_account()
            return
        if path == "/api/logout":
            self.send_session_json({"ok": True}, self.clear_session())
            return
        user = self.require_user({"lecturer"})
        if user is None:
            return
        if path.startswith("/api/courses/") and path.endswith("/materials"):
            course_code = unquote(path.removeprefix("/api/courses/").removesuffix("/materials").strip("/"))
            self.save_course_material(course_code, user)
            return
        if path not in {"/api/courses", "/api/assignments", "/api/classes"}:
            self.send_json({"error": "Not found"}, 404)
            return
        try:
            payload = self.read_payload()
            if path == "/api/courses":
                title, code, instructor = (
                    payload[key].strip() for key in ("title", "code", "instructor")
                )
                if not title or not code or not instructor:
                    raise ValueError("All course fields are required")
                with connect_database() as connection:
                    connection.execute(
                        "INSERT INTO courses (title, code, instructor) VALUES (?, ?, ?)",
                        (title, code.upper(), instructor),
                    )
                self.send_json({"title": title, "code": code.upper(), "instructor": instructor}, 201)
                return

            if path == "/api/classes":
                title = payload["title"].strip()
                course = payload["course"].strip()
                starts_at = payload["starts_at"].strip()
                meeting_url = payload["meeting_url"].strip()
                parsed_url = urlsplit(meeting_url)
                if not title or not course:
                    raise ValueError("Class title and course are required")
                if len(title) > 100 or len(meeting_url) > 500:
                    raise ValueError("Class details exceed the allowed length")
                try:
                    datetime.fromisoformat(starts_at)
                except ValueError as error:
                    raise ValueError("Choose a valid class start date and time") from error
                if parsed_url.scheme != "https" or not parsed_url.hostname or parsed_url.username:
                    raise ValueError("Meeting links must be valid HTTPS URLs")
                class_id = f"class-{uuid.uuid4().hex[:12]}"
                with connect_database() as connection:
                    connection.execute(
                        "INSERT INTO online_classes "
                        "(id, title, course, instructor, starts_at, meeting_url, created_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (class_id, title, course, user["name"], starts_at, meeting_url, int(time.time())),
                    )
                self.send_json({
                    "id": class_id, "title": title, "course": course,
                    "instructor": user["name"], "starts_at": starts_at,
                    "meeting_url": meeting_url,
                }, 201)
                return

            title, course, instructor, due = (
                payload[key].strip() for key in ("title", "course", "instructor", "due")
            )
            if not title or not course or not instructor or not due:
                raise ValueError("All assignment fields are required")
            assignment_id = f"assignment-{__import__('uuid').uuid4().hex[:12]}"
            with connect_database() as connection:
                connection.execute(
                    "INSERT INTO assignments (id, title, course, instructor, due) VALUES (?, ?, ?, ?, ?)",
                    (assignment_id, title, course, instructor, due),
                )
            self.send_json({
                "id": assignment_id, "title": title, "course": course,
                "instructor": instructor, "due": due, "completed": False,
            }, 201)
        except sqlite3.IntegrityError:
            self.send_json({"error": "That course code already exists"}, 409)
        except (ValueError, KeyError, json.JSONDecodeError) as error:
            self.send_json({"error": str(error)}, 400)

    def register_account(self):
        try:
            payload = self.read_payload()
            name = payload["name"].strip()
            email = payload["email"].strip().lower()
            password = payload["password"]
            role = payload["role"]
            if not name or len(name) > 80:
                raise ValueError("Enter your name (up to 80 characters)")
            if len(email) > 254 or "@" not in email or email.startswith("@"):
                raise ValueError("Enter a valid email address")
            if not isinstance(password, str) or len(password) < 8 or len(password) > 128:
                raise ValueError("Password must be between 8 and 128 characters")
            if role not in {"student", "lecturer"}:
                raise ValueError("Choose a valid account type")
            salt = secrets.token_bytes(16)
            password_hash = hashlib.pbkdf2_hmac(
                "sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS
            ).hex()
            with connect_database() as connection:
                cursor = connection.execute(
                    "INSERT INTO users (name, email, password_hash, password_salt, role, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (name, email, password_hash, salt.hex(), role, int(time.time())),
                )
                user_id = cursor.lastrowid
            user = {"id": user_id, "name": name, "email": email, "role": role}
            self.send_session_json({"user": user}, self.set_session(user_id), 201)
        except sqlite3.IntegrityError:
            self.send_json({"error": "An account with this email already exists"}, 409)
        except (ValueError, KeyError, json.JSONDecodeError, TypeError) as error:
            self.send_json({"error": str(error) or "Please check the registration details"}, 400)

    def login_account(self):
        try:
            payload = self.read_payload()
            email = payload["email"].strip().lower()
            password = payload["password"]
            if not isinstance(password, str):
                raise ValueError("Enter your email and password")
            with connect_database() as connection:
                row = connection.execute(
                    "SELECT id, name, email, password_hash, password_salt, role FROM users WHERE email = ?",
                    (email,),
                ).fetchone()
            if row is None:
                self.send_json({"error": "Email or password is incorrect"}, 401)
                return
            candidate = hashlib.pbkdf2_hmac(
                "sha256", password.encode("utf-8"), bytes.fromhex(row[4]), PASSWORD_ITERATIONS
            ).hex()
            if not hmac.compare_digest(candidate, row[3]):
                self.send_json({"error": "Email or password is incorrect"}, 401)
                return
            user = {"id": row[0], "name": row[1], "email": row[2], "role": row[5]}
            self.send_session_json({"user": user}, self.set_session(user["id"]))
        except (ValueError, KeyError, json.JSONDecodeError, TypeError):
            self.send_json({"error": "Enter your email and password"}, 400)

    def do_PATCH(self):
        user = self.require_user({"student"})
        if user is None:
            return
        path = urlparse(self.path).path
        if path.startswith("/api/courses/") and "/lessons/" in path:
            self.update_course_progress(path, user)
            return
        assignment_id = path.removeprefix("/api/assignments/")
        if assignment_id not in ASSIGNMENTS:
            with connect_database() as connection:
                exists = connection.execute(
                    "SELECT 1 FROM assignments WHERE id = ?", (assignment_id,)
                ).fetchone()
            if not exists:
                self.send_json({"error": "Assignment not found"}, 404)
                return

        try:
            payload = self.read_payload()
            completed = payload["completed"]
            if not isinstance(completed, bool):
                raise ValueError("completed must be a boolean")
        except (ValueError, KeyError, json.JSONDecodeError):
            self.send_json({"error": "Expected a JSON boolean named completed"}, 400)
            return

        with connect_database() as connection:
            connection.execute(
                "INSERT INTO assignment_status (assignment_id, completed) VALUES (?, ?) "
                "ON CONFLICT(assignment_id) DO UPDATE SET completed = excluded.completed",
                (assignment_id, int(completed)),
            )
        self.send_json({"id": assignment_id, "completed": completed})

    def update_course_progress(self, path, user):
        course_part, lesson_part = path.removeprefix("/api/courses/").split("/lessons/", 1)
        course_code = unquote(course_part)
        course = self.find_course(course_code)
        if course is None:
            self.send_json({"error": "Course not found"}, 404)
            return
        try:
            lesson_index = int(lesson_part)
            if not 0 <= lesson_index < len(LESSON_TITLES):
                raise ValueError
            payload = self.read_payload()
            completed = payload["completed"]
            if not isinstance(completed, bool):
                raise ValueError
        except (ValueError, KeyError, json.JSONDecodeError):
            self.send_json({"error": "Invalid lesson progress"}, 400)
            return

        with connect_database() as connection:
            has_progress = connection.execute(
                "SELECT 1 FROM course_progress WHERE user_id = ? AND course_code = ? LIMIT 1",
                (user["id"], course_code),
            ).fetchone()
            if not has_progress:
                for index in range(len(LESSON_TITLES)):
                    connection.execute(
                        "INSERT OR IGNORE INTO course_progress "
                        "(user_id, course_code, lesson_index, completed) VALUES (?, ?, ?, ?)",
                        (user["id"], course_code, index, int(index < self.default_completed_count(course))),
                    )
            connection.execute(
                "INSERT INTO course_progress (user_id, course_code, lesson_index, completed) "
                "VALUES (?, ?, ?, ?) ON CONFLICT(user_id, course_code, lesson_index) "
                "DO UPDATE SET completed = excluded.completed",
                (user["id"], course_code, lesson_index, int(completed)),
            )
            completed_count = connection.execute(
                "SELECT SUM(completed) FROM course_progress WHERE user_id = ? AND course_code = ?",
                (user["id"], course_code),
            ).fetchone()[0]
        self.send_json({
            "course_code": course_code,
            "lesson_index": lesson_index,
            "completed": completed,
            "completed_count": completed_count,
            "progress": round(completed_count / len(LESSON_TITLES) * 100),
        })


if __name__ == "__main__":
    address = ("127.0.0.1", 8000)
    server = ThreadingHTTPServer(address, PortalHandler)
    print(f"Northstar student portal running at http://{address[0]}:{address[1]}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nPortal server stopped.")
        server.server_close()