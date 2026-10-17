"""One error shape for every /api error, plain text everywhere else.

``ApiError`` is a Starlette ``HTTPException``, so FastAPI re-raises it unchanged even when it
comes out of reading the request body (the JSON size limit in ``auth.py``).
"""

import logging

from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse, PlainTextResponse

log = logging.getLogger("mdcif_server")

INTERNAL_MESSAGE = "internal server error (see the server log)"


class JSONUTF8Response(JSONResponse):
    """JSON with an explicit ``charset=utf-8``."""

    media_type = "application/json; charset=utf-8"


class ApiError(StarletteHTTPException):
    def __init__(self, status, code, message, fields=None, headers=None):
        super().__init__(status_code=status, detail=message, headers=headers)
        self.code = code
        self.message = message
        self.fields = dict(fields or {})


def is_api(path):
    return path == "/api" or path.startswith("/api/")


def error_body(code, message, fields=None):
    return {"error": {"code": code, "message": message, "fields": dict(fields or {})}}


def error_response(status, code, message, fields=None, headers=None):
    return JSONUTF8Response(error_body(code, message, fields), status_code=status,
                            headers=headers)


def plain_response(status, text, headers=None):
    return PlainTextResponse(text, status_code=status, headers=headers,
                             media_type="text/plain; charset=utf-8")


def internal_error_response(path):
    if is_api(path):
        return error_response(500, "internal_error", INTERNAL_MESSAGE)
    return plain_response(500, "500 Internal Server Error")


def summary_message(fields):
    """``"<first path>: <first msg>"`` plus ``" (and N more)"``."""
    if not fields:
        return "invalid request"
    key, msg = next(iter(fields.items()))
    text = f"{key}: {msg}" if key else msg
    if len(fields) > 1:
        text += f" (and {len(fields) - 1} more)"
    return text


def pydantic_fields(errors, drop_first=False, prefix=""):
    """Dotted request path -> message, one entry per pydantic error (first one wins)."""
    fields = {}
    for err in errors:
        loc = list(err.get("loc", ()))[1 if drop_first else 0:]
        key = ".".join(str(x) for x in ([prefix] if prefix else []) + loc)
        fields.setdefault(key, err.get("msg", "invalid value"))
    return fields


def validation_error(fields):
    return ApiError(422, "validation_error", summary_message(fields), fields)


async def _api_error(request, exc: ApiError):
    if is_api(request.url.path):
        return error_response(exc.status_code, exc.code, exc.message, exc.fields, exc.headers)
    return plain_response(exc.status_code, f"{exc.status_code} {exc.message}", exc.headers)


async def _http_error(request, exc: StarletteHTTPException):
    path = request.url.path
    if not is_api(path):
        # anything that is not a UI route is a plain-text 404
        return plain_response(404, "404 Not Found")
    status = exc.status_code
    if status == 404:
        return error_response(404, "not_found", f"not found: {path}")
    if status == 405:
        return error_response(405, "method_not_allowed",
                              f"method {request.method} is not allowed on {path}",
                              headers=exc.headers)
    if status >= 500:
        return error_response(status, "internal_error", INTERNAL_MESSAGE)
    message = exc.detail if isinstance(exc.detail, str) and exc.detail else "bad request"
    return error_response(status, "bad_request", message, headers=exc.headers)


async def _validation_error(request, exc: RequestValidationError):
    errors = list(exc.errors())
    if any(e.get("type") == "json_invalid" for e in errors):
        err = next(e for e in errors if e.get("type") == "json_invalid")
        detail = (err.get("ctx") or {}).get("error") or err.get("msg", "")
        return error_response(400, "bad_request", f"invalid JSON body: {detail}")
    if any(tuple(e.get("loc", ())) == ("body",) for e in errors):
        return error_response(400, "bad_request",
                              "the request body must be a JSON object "
                              "(Content-Type: application/json)")
    fields = pydantic_fields(errors, drop_first=True)
    return error_response(422, "validation_error", summary_message(fields), fields)


def install_handlers(app):
    app.add_exception_handler(ApiError, _api_error)
    app.add_exception_handler(StarletteHTTPException, _http_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
