"""OWNER: be-detect — the one error type, rendered in Arvo's wire shape.

`{"error": {"code": "<snake_case>", "message": "<human text>"}}` with the code vocabulary of
docs/API.md, so the Rust worker can surface a failure without a second parser.
"""

from typing import Optional

#: Code → HTTP status, the subset this service can produce.
STATUS = {
    "bad_request": 400,
    "not_found": 404,
    "unprocessable": 422,
    "internal": 500,
}


class DetectError(Exception):
    """Raised anywhere in the pipeline; the FastAPI handler renders it."""

    def __init__(self, code: str, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status or STATUS.get(code, 400)

    def body(self) -> dict:
        return {"error": {"code": self.code, "message": self.message}}
