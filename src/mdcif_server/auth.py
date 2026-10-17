"""Token authentication and common response headers, as ASGI middleware.

Every request needs the token: the cookie ``mdcif_token_<port>``, an ``Authorization: Bearer``
header, or the landing request ``GET /?token=...``, which sets the cookie and redirects to
``/``. The middleware also adds the security headers, caps JSON bodies at 1 MiB, logs requests
without their query string, and turns unexpected exceptions into a 500 in the error shape.
"""

import hmac
import logging
from urllib.parse import parse_qsl

from starlette.datastructures import Headers, MutableHeaders
from starlette.requests import cookie_parser
from starlette.responses import Response

from .errors import (
    ApiError,
    error_response,
    internal_error_response,
    is_api,
    plain_response,
)
from .settings import JSON_BODY_LIMIT

log = logging.getLogger("mdcif_server")

COOKIE_MAX_AGE = 2592000
API_401_MESSAGE = "missing or invalid token: open the link printed by mdcif-server"


def _body_too_large():
    return ApiError(413, "body_too_large",
                    f"the request body is larger than {JSON_BODY_LIMIT} bytes")


class AuthMiddleware:
    def __init__(self, app, settings):
        self.app = app
        self.settings = settings
        self.token = settings.token.encode()

    def _valid(self, value):
        return hmac.compare_digest(value.encode("utf-8", "replace"), self.token)

    def _authenticated(self, headers):
        auth = headers.get("authorization", "")
        if auth[:7].lower() == "bearer " and self._valid(auth[7:].strip()):
            return True
        cookie = cookie_parser(headers.get("cookie", "")).get(self.settings.cookie_name)
        return cookie is not None and self._valid(cookie)

    def _unauthorized(self, path):
        if is_api(path):
            return error_response(401, "unauthorized", API_401_MESSAGE,
                                  headers={"WWW-Authenticate": "Bearer"})
        return plain_response(401, "401 Unauthorized: open the link printed by mdcif-server "
                                   f"(http://127.0.0.1:{self.settings.port}/?token=...).")

    def _landing(self, token):
        if not self._valid(token):
            return self._unauthorized("/")
        cookie = (f"{self.settings.cookie_name}={self.settings.token}; HttpOnly; "
                  f"SameSite=Strict; Path=/; Max-Age={COOKIE_MAX_AGE}")
        return Response(status_code=303, headers={"Location": "/", "Set-Cookie": cookie,
                                                  "Cache-Control": "no-store"})

    async def __call__(self, scope, receive, send):
        if scope["type"] == "websocket":         # no websocket routes: refuse
            await send({"type": "websocket.close", "code": 1008})
            return
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path, method = scope["path"], scope["method"]
        api = is_api(path)
        status = {"code": None}

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
                headers = MutableHeaders(scope=message)
                headers["Referrer-Policy"] = "no-referrer"
                headers["X-Content-Type-Options"] = "nosniff"
                if api:
                    headers["Cache-Control"] = "no-store"
            await send(message)

        try:
            response = None
            headers = Headers(scope=scope)
            query = dict(parse_qsl(scope.get("query_string", b"").decode("latin-1"),
                                   keep_blank_values=True))
            if method == "GET" and path == "/" and "token" in query:
                response = self._landing(query["token"])
            elif not self._authenticated(headers):
                response = self._unauthorized(path)
            elif api and not (method == "PUT" and path.startswith("/api/uploads/")):
                length = headers.get("content-length")
                if length is not None and length.isdigit() and int(length) > JSON_BODY_LIMIT:
                    exc = _body_too_large()
                    response = error_response(413, exc.code, exc.message)
                else:
                    receive = _limited(receive, JSON_BODY_LIMIT)
            if response is not None:
                await response(scope, receive, send_with_headers)
            else:
                await self.app(scope, receive, send_with_headers)
        except Exception as exc:
            if isinstance(exc, ApiError) and status["code"] is None and api:
                await error_response(exc.status_code, exc.code, exc.message,
                                     exc.fields)(scope, receive, send_with_headers)
            else:
                log.exception("error in %s %s", method, path)
                if status["code"] is None:
                    await internal_error_response(path)(scope, receive, send_with_headers)
        finally:
            log.debug("%s %s %s", method, path, status["code"])


def _limited(receive, limit):
    """``receive`` that raises 413 body_too_large once more than ``limit`` bytes arrived."""
    total = 0

    async def wrapped():
        nonlocal total
        message = await receive()
        if message["type"] == "http.request":
            total += len(message.get("body", b""))
            if total > limit:
                raise _body_too_large()
        return message

    return wrapped
