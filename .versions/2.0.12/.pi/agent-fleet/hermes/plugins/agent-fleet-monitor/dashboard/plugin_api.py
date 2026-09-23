"""Manifest-mounted, fail-closed local Agent Fleet monitor boundary."""

from fastapi import APIRouter, HTTPException

from adapter import MonitorAdapter, MonitorUnavailable

router = APIRouter()
MAX_TASK_ID_LENGTH = 128
MAX_AFTER_SEQUENCE = 1_000_000_000

def validate_task_request(task_id: str, generation: int, after_sequence: int | None = None) -> None:
    if not isinstance(task_id, str) or not 1 <= len(task_id) <= MAX_TASK_ID_LENGTH or not __import__("re").fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", task_id):
        raise HTTPException(status_code=422, detail="invalid task_id")
    if type(generation) is not int or generation < 1:
        raise HTTPException(status_code=422, detail="invalid generation")
    if after_sequence is not None and (type(after_sequence) is not int or not 0 <= after_sequence <= MAX_AFTER_SEQUENCE):
        raise HTTPException(status_code=422, detail="invalid after_sequence")


@router.get("/capabilities")
def capabilities() -> dict[str, bool]:
    return {"monitor_adapter": True}


@router.get("/snapshot")
def snapshot() -> dict:
    try:
        return MonitorAdapter.from_profile_environment().snapshot()
    except MonitorUnavailable as error:
        raise HTTPException(status_code=503, detail="local Agent Fleet monitor unavailable") from error


@router.get("/output")
def output(task_id: str, generation: int, after_sequence: int, hub_instance_id: str) -> dict:
    validate_task_request(task_id, generation, after_sequence)
    if not isinstance(hub_instance_id, str) or not hub_instance_id: raise HTTPException(status_code=422, detail="invalid hub_instance_id")
    try:
        return MonitorAdapter.from_profile_environment().output(task_id, generation, after_sequence, hub_instance_id)
    except MonitorUnavailable as error:
        raise HTTPException(status_code=503, detail="local Agent Fleet monitor unavailable") from error


@router.post("/cancel")
def cancel(task_id: str, generation: int, hub_instance_id: str) -> dict:
    validate_task_request(task_id, generation)
    if not isinstance(hub_instance_id, str) or not hub_instance_id: raise HTTPException(status_code=422, detail="invalid hub_instance_id")
    try:
        return MonitorAdapter.from_profile_environment().cancel(task_id, generation, hub_instance_id)
    except MonitorUnavailable as error:
        raise HTTPException(status_code=503, detail="local Agent Fleet monitor unavailable") from error
