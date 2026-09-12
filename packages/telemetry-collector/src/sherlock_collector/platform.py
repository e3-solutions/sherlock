"""Dependency-free operating-system boundary for the collector runtime."""

from __future__ import annotations

import contextlib
import os
import re
import stat
import subprocess
from pathlib import Path
from typing import BinaryIO, Iterator, Mapping, Sequence

WINDOWS = os.name == "nt"


def _current_user_sid() -> str:
    import ctypes
    from ctypes import wintypes

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    advapi32.OpenProcessToken.argtypes = (
        wintypes.HANDLE,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.HANDLE),
    )
    advapi32.GetTokenInformation.argtypes = (
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    )
    advapi32.ConvertSidToStringSidW.argtypes = (
        ctypes.c_void_p,
        ctypes.POINTER(wintypes.LPWSTR),
    )
    kernel32.LocalFree.argtypes = (ctypes.c_void_p,)
    kernel32.LocalFree.restype = ctypes.c_void_p
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    token = wintypes.HANDLE()
    if not advapi32.OpenProcessToken(
        kernel32.GetCurrentProcess(), 0x0008, ctypes.byref(token)
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        needed = wintypes.DWORD()
        advapi32.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))
        buffer = ctypes.create_string_buffer(needed.value)
        if not advapi32.GetTokenInformation(
            token, 1, buffer, needed, ctypes.byref(needed)
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        sid = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0]
        rendered = wintypes.LPWSTR()
        if not advapi32.ConvertSidToStringSidW(sid, ctypes.byref(rendered)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return rendered.value
        finally:
            kernel32.LocalFree(rendered)
    finally:
        kernel32.CloseHandle(token)


def secure_path(path: Path | str, *, directory: bool) -> None:
    """Restrict a collector path to its owner (and Windows SYSTEM)."""
    target = Path(path)
    if not WINDOWS:
        os.chmod(target, 0o700 if directory else 0o600)
        return
    import ctypes
    from ctypes import wintypes

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    descriptor = wintypes.LPVOID()
    current_sid = _current_user_sid()
    ace_flags = "OICI" if directory else ""
    sddl = (
        f"O:{current_sid}D:P"
        f"(A;{ace_flags};FA;;;{current_sid})(A;{ace_flags};FA;;;SY)"
    )
    advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = (
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.LPVOID),
        ctypes.POINTER(wintypes.DWORD),
    )
    advapi32.GetSecurityDescriptorOwner.argtypes = (
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(wintypes.BOOL),
    )
    advapi32.GetSecurityDescriptorDacl.argtypes = (
        ctypes.c_void_p,
        ctypes.POINTER(wintypes.BOOL),
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(wintypes.BOOL),
    )
    advapi32.SetNamedSecurityInfoW.argtypes = (
        wintypes.LPWSTR,
        ctypes.c_int,
        wintypes.DWORD,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
    )
    advapi32.SetNamedSecurityInfoW.restype = wintypes.DWORD
    kernel32.LocalFree.argtypes = (ctypes.c_void_p,)
    kernel32.LocalFree.restype = ctypes.c_void_p
    if not advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl, 1, ctypes.byref(descriptor), None
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        owner = ctypes.c_void_p()
        owner_defaulted = wintypes.BOOL()
        dacl_present = wintypes.BOOL()
        dacl = ctypes.c_void_p()
        dacl_defaulted = wintypes.BOOL()
        if not advapi32.GetSecurityDescriptorOwner(
            descriptor, ctypes.byref(owner), ctypes.byref(owner_defaulted)
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        if not advapi32.GetSecurityDescriptorDacl(
            descriptor,
            ctypes.byref(dacl_present),
            ctypes.byref(dacl),
            ctypes.byref(dacl_defaulted),
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        if not dacl_present:
            raise OSError("collector security descriptor has no DACL")
        error = advapi32.SetNamedSecurityInfoW(
            ctypes.create_unicode_buffer(str(target)),
            1,
            0x80000005,
            owner,
            None,
            dacl,
            None,
        )
        if error:
            raise ctypes.WinError(error)
    finally:
        kernel32.LocalFree(descriptor)


def secure_directory(path: Path | str) -> Path:
    target = Path(path)
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    secure_path(target, directory=True)
    return target


def windows_security_descriptor(path: Path | str) -> str:
    """Return owner and DACL SDDL for native Windows security diagnostics."""
    if not WINDOWS:
        raise OSError("Windows security descriptors are unavailable")
    import ctypes
    from ctypes import wintypes

    target = Path(path)
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi32.GetFileSecurityW.argtypes = (
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    )
    advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = (
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.LPWSTR),
        ctypes.POINTER(wintypes.DWORD),
    )
    kernel32.LocalFree.argtypes = (ctypes.c_void_p,)
    kernel32.LocalFree.restype = ctypes.c_void_p
    information = 0x00000001 | 0x00000004
    needed = wintypes.DWORD()
    advapi32.GetFileSecurityW(str(target), information, None, 0, ctypes.byref(needed))
    buffer = ctypes.create_string_buffer(needed.value)
    if not advapi32.GetFileSecurityW(
        str(target), information, buffer, needed, ctypes.byref(needed)
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    rendered = wintypes.LPWSTR()
    if not advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW(
        buffer, 1, information, ctypes.byref(rendered), None
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return rendered.value
    finally:
        kernel32.LocalFree(rendered)


def is_owner_only(path: Path | str) -> bool:
    """Validate the native permission boundary used for collector secrets."""
    target = Path(path)
    if not WINDOWS:
        return not (stat.S_IMODE(target.stat().st_mode) & 0o077)

    sddl = windows_security_descriptor(target)
    current_sid = _current_user_sid()
    owner = re.search(r"O:(.*?)(?=[GDS]:|$)", sddl)
    dacl = sddl[sddl.find("D:") :] if "D:" in sddl else ""
    aces = [ace.split(";") for ace in re.findall(r"\(([^)]*)\)", dacl)]
    allowed = {
        fields[5]
        for fields in aces
        if len(fields) == 6
        and fields[0] == "A"
        and fields[2].lower() in {"fa", "0x1f01ff"}
    }
    return bool(
        owner
        and owner.group(1) in {current_sid}
        and dacl.startswith("D:P")
        and len(aces) == 2
        and allowed == {current_sid, "SY"}
    )


@contextlib.contextmanager
def nonblocking_lock(path: Path | str) -> Iterator[bool]:
    """Hold an exclusive lock which the OS releases when its process dies."""
    target = Path(path)
    secure_directory(target.parent)
    handle = os.fdopen(os.open(target, os.O_RDWR | os.O_CREAT, 0o600), "a+b")
    acquired = False
    try:
        secure_path(target, directory=False)
        if WINDOWS:
            import msvcrt

            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                acquired = True
            except OSError:
                pass
        else:
            import fcntl

            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except BlockingIOError:
                pass
        yield acquired
    finally:
        if acquired and WINDOWS:
            import msvcrt

            handle.seek(0)
            with contextlib.suppress(OSError):
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        handle.close()


def durable_replace(source: Path | str, destination: Path | str) -> None:
    source_path, destination_path = Path(source), Path(destination)
    if WINDOWS:
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.MoveFileExW.argtypes = (
            ctypes.c_wchar_p,
            ctypes.c_wchar_p,
            ctypes.c_uint32,
        )
        if not kernel32.MoveFileExW(str(source_path), str(destination_path), 0x1 | 0x8):
            raise ctypes.WinError(ctypes.get_last_error())
        return
    os.replace(source_path, destination_path)
    parents = {source_path.parent, destination_path.parent}
    for parent in parents:
        directory_fd = os.open(parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)


def file_identity(handle: BinaryIO) -> tuple[int, int]:
    details = os.fstat(handle.fileno())
    if not WINDOWS or details.st_ino:
        return details.st_dev, details.st_ino
    import ctypes
    import msvcrt
    from ctypes import wintypes

    class FileInformation(ctypes.Structure):
        _fields_ = [
            ("attributes", wintypes.DWORD),
            ("created", wintypes.FILETIME),
            ("accessed", wintypes.FILETIME),
            ("written", wintypes.FILETIME),
            ("volume", wintypes.DWORD),
            ("size_high", wintypes.DWORD),
            ("size_low", wintypes.DWORD),
            ("links", wintypes.DWORD),
            ("index_high", wintypes.DWORD),
            ("index_low", wintypes.DWORD),
        ]

    information = FileInformation()
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetFileInformationByHandle.argtypes = (wintypes.HANDLE, ctypes.c_void_p)
    if not kernel32.GetFileInformationByHandle(
        wintypes.HANDLE(msvcrt.get_osfhandle(handle.fileno())),
        ctypes.byref(information),
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    return information.volume, (information.index_high << 32) | information.index_low


def spawn_detached(
    command: Sequence[str], environment: Mapping[str, str] | None = None
):
    options = dict(
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        env=dict(environment) if environment is not None else None,
    )
    if WINDOWS:
        options["creationflags"] = 0x00000008 | 0x00000200
    else:
        options["start_new_session"] = True
    return subprocess.Popen(list(command), **options)


def open_regular_under(root: Path, candidate: Path) -> BinaryIO:
    resolved_root = root.resolve(strict=True)
    if not WINDOWS:
        resolved_candidate = candidate.resolve(strict=True)
        try:
            resolved_candidate.relative_to(resolved_root)
        except ValueError as error:
            raise ValueError("capture path is outside allowed_root") from error
        descriptor = os.open(resolved_candidate, os.O_RDONLY)
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            os.close(descriptor)
            raise OSError("capture path is not a regular file")
        return os.fdopen(descriptor, "rb")

    import ctypes
    import msvcrt
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.argtypes = (
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    )
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.GetFinalPathNameByHandleW.argtypes = (
        wintypes.HANDLE,
        wintypes.LPWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
    )
    kernel32.GetFinalPathNameByHandleW.restype = wintypes.DWORD
    kernel32.GetFileAttributesW.argtypes = (wintypes.LPCWSTR,)
    kernel32.GetFileAttributesW.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    native = kernel32.CreateFileW(
        str(candidate),
        0x80000000,
        0x1 | 0x2 | 0x4,
        None,
        3,
        0x00200000 | 0x02000000,
        None,
    )
    if native == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        buffer = ctypes.create_unicode_buffer(32768)
        length = kernel32.GetFinalPathNameByHandleW(native, buffer, len(buffer), 0)
        if not length or length >= len(buffer):
            raise ctypes.WinError(ctypes.get_last_error())
        final_name = buffer.value.removeprefix("\\\\?\\")
        final_path = Path(final_name).resolve(strict=True)
        try:
            final_path.relative_to(resolved_root)
        except ValueError as error:
            raise ValueError("capture path is outside allowed_root") from error
        attributes = kernel32.GetFileAttributesW(str(candidate))
        if attributes == 0xFFFFFFFF or attributes & 0x400:
            raise OSError("capture path is a reparse point")
        descriptor = msvcrt.open_osfhandle(native, os.O_RDONLY | os.O_BINARY)
        native = None
        return os.fdopen(descriptor, "rb")
    finally:
        if native is not None:
            kernel32.CloseHandle(native)
