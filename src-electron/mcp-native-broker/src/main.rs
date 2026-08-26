#![cfg(windows)]

use std::ffi::c_void;
use std::fs::File;
use std::io::{self, Read, Write};
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};
use std::sync::Arc;
use std::thread;

type Handle = *mut c_void;
type Bool = i32;
type Dword = u32;
type NtStatus = i32;

const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
const ERROR_PIPE_CONNECTED: Dword = 535;
const STATUS_INFO_LENGTH_MISMATCH: NtStatus = -1073741820;
const PROCESS_QUERY_LIMITED_INFORMATION: Dword = 0x1000;
const TOKEN_QUERY: Dword = 0x0008;
const GENERIC_READ: Dword = 0x8000_0000;
const GENERIC_WRITE: Dword = 0x4000_0000;
const OPEN_EXISTING: Dword = 3;
const PIPE_ACCESS_DUPLEX: Dword = 0x0000_0003;
const FILE_FLAG_FIRST_PIPE_INSTANCE: Dword = 0x0008_0000;
const PIPE_TYPE_BYTE: Dword = 0;
const PIPE_READMODE_BYTE: Dword = 0;
const PIPE_WAIT: Dword = 0;
const PIPE_REJECT_REMOTE_CLIENTS: Dword = 0x0000_0008;
const PIPE_UNLIMITED_INSTANCES: Dword = 255;
const TOKEN_USER_CLASS: Dword = 1;
const BCRYPT_OBJECT_LENGTH: &str = "ObjectLength";
const BCRYPT_SHA256_ALGORITHM: &str = "SHA256";
const MCP_EXTERNAL_PIPE_PROTOCOL_VERSION: &str = "moonshine-mcp-external-pipe-v1";
const MCP_EXTERNAL_BROKER_BOOTSTRAP_PROTOCOL: &str = "moonshine-mcp-broker-bootstrap-v1";
const MAX_FRAME_BYTES: usize = 64 * 1024;

#[repr(C)]
struct SecurityAttributes {
    n_length: Dword,
    security_descriptor: *mut c_void,
    inherit_handle: Bool,
}

#[repr(C)]
struct SidAndAttributes {
    sid: *mut c_void,
    attributes: Dword,
}

#[repr(C)]
struct TokenUser {
    user: SidAndAttributes,
}

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *const u16,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateNamedPipeW(name: *const u16, open_mode: Dword, pipe_mode: Dword, max_instances: Dword, out_buffer_size: Dword, in_buffer_size: Dword, default_timeout: Dword, attributes: *const SecurityAttributes) -> Handle;
    fn ConnectNamedPipe(pipe: Handle, overlapped: *mut c_void) -> Bool;
    fn GetNamedPipeClientProcessId(pipe: Handle, process_id: *mut Dword) -> Bool;
    fn CreateFileW(name: *const u16, desired_access: Dword, share_mode: Dword, security_attributes: *mut SecurityAttributes, creation_disposition: Dword, flags_and_attributes: Dword, template_file: Handle) -> Handle;
    fn WaitNamedPipeW(name: *const u16, timeout: Dword) -> Bool;
    fn ReadFile(handle: Handle, buffer: *mut c_void, bytes_to_read: Dword, bytes_read: *mut Dword, overlapped: *mut c_void) -> Bool;
    fn WriteFile(handle: Handle, buffer: *const c_void, bytes_to_write: Dword, bytes_written: *mut Dword, overlapped: *mut c_void) -> Bool;
    fn CloseHandle(handle: Handle) -> Bool;
    fn GetLastError() -> Dword;
    fn OpenProcess(desired_access: Dword, inherit_handle: Bool, process_id: Dword) -> Handle;
    fn QueryFullProcessImageNameW(process: Handle, flags: Dword, executable_path: *mut u16, size: *mut Dword) -> Bool;
    fn GetCurrentProcess() -> Handle;
    fn LocalFree(memory: Handle) -> Handle;
}

#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: Handle, desired_access: Dword, token: *mut Handle) -> Bool;
    fn GetTokenInformation(token: Handle, token_information_class: Dword, token_information: *mut c_void, token_information_length: Dword, return_length: *mut Dword) -> Bool;
    fn ConvertSidToStringSidW(sid: *mut c_void, string_sid: *mut *mut u16) -> Bool;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(string_security_descriptor: *const u16, string_sd_revision: Dword, security_descriptor: *mut *mut c_void, security_descriptor_size: *mut Dword) -> Bool;
}

#[link(name = "bcrypt")]
extern "system" {
    fn BCryptOpenAlgorithmProvider(algorithm: *mut Handle, algorithm_id: *const u16, implementation: *const u16, flags: Dword) -> NtStatus;
    fn BCryptCloseAlgorithmProvider(algorithm: Handle, flags: Dword) -> NtStatus;
    fn BCryptGetProperty(object: Handle, property: *const u16, output: *mut u8, output_size: Dword, result_size: *mut Dword, flags: Dword) -> NtStatus;
    fn BCryptCreateHash(algorithm: Handle, hash: *mut Handle, hash_object: *mut u8, hash_object_size: Dword, secret: *const u8, secret_size: Dword, flags: Dword) -> NtStatus;
    fn BCryptHashData(hash: Handle, input: *const u8, input_size: Dword, flags: Dword) -> NtStatus;
    fn BCryptFinishHash(hash: Handle, output: *mut u8, output_size: Dword, flags: Dword) -> NtStatus;
    fn BCryptDestroyHash(hash: Handle) -> NtStatus;
}

#[link(name = "ntdll")]
extern "system" {
    fn NtQueryInformationProcess(process: Handle, process_information_class: Dword, process_information: *mut c_void, process_information_length: Dword, return_length: *mut Dword) -> NtStatus;
}

#[link(name = "shell32")]
extern "system" {
    fn CommandLineToArgvW(command_line: *const u16, argument_count: *mut i32) -> *mut *mut u16;
}

#[derive(Clone)]
struct Bootstrap {
    public_pipe_name: String,
    private_pipe_name: String,
    broker_secret: String,
    expected_proxy_executable_path: String,
    expected_proxy_executable_sha256: String,
    expected_proxy_path: String,
    expected_proxy_sha256: String,
}

fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn status_ok(status: NtStatus) -> bool { status >= 0 }

fn is_valid_handle(handle: Handle) -> bool { !handle.is_null() && handle != INVALID_HANDLE_VALUE }

fn close_handle(handle: Handle) {
    if is_valid_handle(handle) { unsafe { CloseHandle(handle); }
    }
}

fn normalize_windows_path(value: &str) -> String {
    value.trim().trim_start_matches(r"\?\").replace('/', r"\").to_lowercase()
}

fn sha256_file(path: &str) -> Result<String, String> {
    let mut algorithm: Handle = null_mut();
    let algorithm_name = wide(BCRYPT_SHA256_ALGORITHM);
    if !status_ok(unsafe { BCryptOpenAlgorithmProvider(&mut algorithm, algorithm_name.as_ptr(), null(), 0) }) {
        return Err("MCP_BROKER_SHA256_PROVIDER_FAILED".into());
    }
    let object_length_name = wide(BCRYPT_OBJECT_LENGTH);
    let mut object_length = 0u32;
    let mut returned = 0u32;
    let property_status = unsafe {
        BCryptGetProperty(algorithm, object_length_name.as_ptr(), &mut object_length as *mut u32 as *mut u8, size_of::<u32>() as u32, &mut returned, 0)
    };
    if !status_ok(property_status) || object_length == 0 {
        unsafe { BCryptCloseAlgorithmProvider(algorithm, 0); }
        return Err("MCP_BROKER_SHA256_PROVIDER_FAILED".into());
    }
    let mut object = vec![0u8; object_length as usize];
    let mut hash: Handle = null_mut();
    let create_status = unsafe { BCryptCreateHash(algorithm, &mut hash, object.as_mut_ptr(), object_length, null(), 0, 0) };
    if !status_ok(create_status) {
        unsafe { BCryptCloseAlgorithmProvider(algorithm, 0); }
        return Err("MCP_BROKER_SHA256_PROVIDER_FAILED".into());
    }
    let result = (|| {
        let mut file = File::open(path).map_err(|_| "MCP_BROKER_PROXY_RESOURCE_MISSING".to_string())?;
        let mut buffer = [0u8; 32 * 1024];
        loop {
            let count = file.read(&mut buffer).map_err(|_| "MCP_BROKER_SHA256_READ_FAILED".to_string())?;
            if count == 0 { break; }
            if !status_ok(unsafe { BCryptHashData(hash, buffer.as_ptr(), count as u32, 0) }) {
                return Err("MCP_BROKER_SHA256_FAILED".into());
            }
        }
        let mut bytes = [0u8; 32];
        if !status_ok(unsafe { BCryptFinishHash(hash, bytes.as_mut_ptr(), bytes.len() as u32, 0) }) {
            return Err("MCP_BROKER_SHA256_FAILED".into());
        }
        Ok(bytes.iter().map(|byte| format!("{:02x}", byte)).collect::<String>())
    })();
    unsafe { BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm, 0); }
    result
}

fn current_user_sddl() -> Result<String, String> {
    let mut token: Handle = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err("MCP_BROKER_TOKEN_OPEN_FAILED".into());
    }
    let result = (|| {
        let mut required = 0u32;
        unsafe { GetTokenInformation(token, TOKEN_USER_CLASS, null_mut(), 0, &mut required); }
        if required == 0 { return Err("MCP_BROKER_TOKEN_INFO_FAILED".into()); }
        let mut bytes = vec![0u8; required as usize];
        if unsafe { GetTokenInformation(token, TOKEN_USER_CLASS, bytes.as_mut_ptr() as *mut c_void, required, &mut required) } == 0 {
            return Err("MCP_BROKER_TOKEN_INFO_FAILED".into());
        }
        let user = unsafe { &*(bytes.as_ptr() as *const TokenUser) };
        let mut sid_text: *mut u16 = null_mut();
        if unsafe { ConvertSidToStringSidW(user.user.sid, &mut sid_text) } == 0 || sid_text.is_null() {
            return Err("MCP_BROKER_TOKEN_SID_FAILED".into());
        }
        let length = unsafe { let mut n = 0usize; while *sid_text.add(n) != 0 { n += 1; } n };
        let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(sid_text, length) });
        unsafe { LocalFree(sid_text as Handle); }
        // This listener belongs to a per-user desktop process. No administrator
        // or other local-user ACE is granted.
        Ok(format!("D:P(A;;GA;;;{})", sid))
    })();
    close_handle(token);
    result
}

fn create_public_pipe(name: &str, first_instance: bool) -> Result<Handle, String> {
    let sddl = current_user_sddl()?;
    let sddl_wide = wide(&sddl);
    let mut security_descriptor: *mut c_void = null_mut();
    if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl_wide.as_ptr(), 1, &mut security_descriptor, null_mut()) } == 0 {
        return Err("MCP_BROKER_DACL_FAILED".into());
    }
    let security = SecurityAttributes { n_length: size_of::<SecurityAttributes>() as u32, security_descriptor, inherit_handle: 0 };
    let name_wide = wide(name);
    let handle = unsafe {
        CreateNamedPipeW(
            name_wide.as_ptr(),
            PIPE_ACCESS_DUPLEX | if first_instance { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 },
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            MAX_FRAME_BYTES as u32,
            MAX_FRAME_BYTES as u32,
            0,
            &security,
        )
    };
    unsafe { LocalFree(security_descriptor as Handle); }
    if !is_valid_handle(handle) {
        return Err(if unsafe { GetLastError() } == 5 { "MCP_BROKER_PIPE_NAME_IN_USE" } else { "MCP_BROKER_PIPE_CREATE_FAILED" }.into());
    }
    Ok(handle)
}

fn process_image(process_id: u32) -> Result<(Handle, String), String> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if !is_valid_handle(handle) { return Err("MCP_BROKER_CLIENT_PROCESS_DENIED".into()); }
    let mut buffer = vec![0u16; 32_768];
    let mut length = (buffer.len() - 1) as u32;
    if unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) } == 0 {
        close_handle(handle);
        return Err("MCP_BROKER_CLIENT_IMAGE_UNAVAILABLE".into());
    }
    Ok((handle, String::from_utf16_lossy(&buffer[..length as usize])))
}

fn process_command_line(process: Handle) -> Result<Vec<String>, String> {
    let mut words = vec![0usize; 4096];
    let mut returned = 0u32;
    let mut status = unsafe { NtQueryInformationProcess(process, 60, words.as_mut_ptr() as *mut c_void, (words.len() * size_of::<usize>()) as u32, &mut returned) };
    if status == STATUS_INFO_LENGTH_MISMATCH && returned > 0 {
        words.resize((returned as usize + size_of::<usize>() - 1) / size_of::<usize>(), 0);
        status = unsafe { NtQueryInformationProcess(process, 60, words.as_mut_ptr() as *mut c_void, returned, &mut returned) };
    }
    if !status_ok(status) { return Err("MCP_BROKER_CLIENT_COMMAND_UNAVAILABLE".into()); }
    let command = unsafe { &*(words.as_ptr() as *const UnicodeString) };
    if command.buffer.is_null() || command.length == 0 || command.length % 2 != 0 { return Err("MCP_BROKER_CLIENT_COMMAND_INVALID".into()); }
    let mut terminated = Vec::from(unsafe { std::slice::from_raw_parts(command.buffer, (command.length / 2) as usize) });
    terminated.push(0);
    let mut count = 0i32;
    let argv = unsafe { CommandLineToArgvW(terminated.as_ptr(), &mut count) };
    if argv.is_null() || count < 1 { return Err("MCP_BROKER_CLIENT_COMMAND_INVALID".into()); }
    let values = unsafe {
        (0..count as usize).map(|index| {
            let value = *argv.add(index);
            let mut length = 0usize;
            while *value.add(length) != 0 { length += 1; }
            String::from_utf16_lossy(std::slice::from_raw_parts(value, length))
        }).collect::<Vec<_>>()
    };
    unsafe { LocalFree(argv as Handle); }
    Ok(values)
}

fn verify_client_process(pipe: Handle, bootstrap: &Bootstrap) -> Result<(), String> {
    let mut process_id = 0u32;
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut process_id) } == 0 || process_id == 0 {
        return Err("MCP_BROKER_CLIENT_PID_UNAVAILABLE".into());
    }
    let (process, image_path) = process_image(process_id)?;
    let result = (|| {
        if normalize_windows_path(&image_path) != normalize_windows_path(&bootstrap.expected_proxy_executable_path) {
            return Err("MCP_BROKER_CLIENT_IMAGE_DENIED".into());
        }
        let image_hash = sha256_file(&image_path)?;
        if !image_hash.eq_ignore_ascii_case(&bootstrap.expected_proxy_executable_sha256) {
            return Err("MCP_BROKER_CLIENT_IMAGE_HASH_DENIED".into());
        }
        let args = process_command_line(process)?;
        let expected_proxy = normalize_windows_path(&bootstrap.expected_proxy_path);
        if !args.iter().any(|arg| normalize_windows_path(arg) == expected_proxy) {
            return Err("MCP_BROKER_CLIENT_PROXY_ARGUMENT_DENIED".into());
        }
        Ok(())
    })();
    close_handle(process);
    result
}

fn connect_private_pipe(name: &str) -> Result<Handle, String> {
    let name_wide = wide(name);
    for _ in 0..20 {
        let handle = unsafe { CreateFileW(name_wide.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, null_mut(), OPEN_EXISTING, 0, null_mut()) };
        if is_valid_handle(handle) { return Ok(handle); }
        let error = unsafe { GetLastError() };
        if error != 2 && error != 231 { return Err("MCP_BROKER_PRIVATE_PIPE_CONNECT_FAILED".into()); }
        unsafe { WaitNamedPipeW(name_wide.as_ptr(), 250); }
    }
    Err("MCP_BROKER_PRIVATE_PIPE_CONNECT_TIMEOUT".into())
}

fn write_all(handle: Handle, bytes: &[u8]) -> Result<(), String> {
    let mut offset = 0usize;
    while offset < bytes.len() {
        let mut written = 0u32;
        if unsafe { WriteFile(handle, bytes[offset..].as_ptr() as *const c_void, (bytes.len() - offset).min(u32::MAX as usize) as u32, &mut written, null_mut()) } == 0 || written == 0 {
            return Err("MCP_BROKER_RELAY_WRITE_FAILED".into());
        }
        offset += written as usize;
    }
    Ok(())
}

fn read_line(handle: Handle) -> Result<Vec<u8>, String> {
    let mut value = Vec::with_capacity(512);
    loop {
        if value.len() >= MAX_FRAME_BYTES { return Err("MCP_BROKER_PRIVATE_HANDSHAKE_TOO_LARGE".into()); }
        let mut byte = [0u8; 1];
        let mut read = 0u32;
        if unsafe { ReadFile(handle, byte.as_mut_ptr() as *mut c_void, 1, &mut read, null_mut()) } == 0 || read != 1 {
            return Err("MCP_BROKER_PRIVATE_HANDSHAKE_FAILED".into());
        }
        value.push(byte[0]);
        if byte[0] == b'\n' { return Ok(value); }
    }
}

fn serve_client(public_pipe: Handle, bootstrap: Arc<Bootstrap>) {
    let private_pipe = match (|| -> Result<Handle, String> {
        verify_client_process(public_pipe, &bootstrap)?;
        let private_pipe = connect_private_pipe(&bootstrap.private_pipe_name)?;
        let handshake = format!("{{\"jsonrpc\":\"2.0\",\"id\":\"broker_attest\",\"method\":\"moonshine.external.broker_attest\",\"params\":{{\"protocol_version\":\"{}\",\"broker_secret\":\"{}\"}}}}\n", MCP_EXTERNAL_PIPE_PROTOCOL_VERSION, bootstrap.broker_secret);
        write_all(private_pipe, handshake.as_bytes())?;
        let response = read_line(private_pipe)?;
        if !String::from_utf8_lossy(&response).contains("\"broker_attested\":true") {
            close_handle(private_pipe);
            return Err("MCP_BROKER_PRIVATE_ATTESTATION_DENIED".into());
        }
        Ok(private_pipe)
    })() {
        Ok(value) => value,
        Err(_) => {
            close_handle(public_pipe);
            return;
        }
    };
    loop {
        let request = match read_line(public_pipe) {
            Ok(value) => value,
            Err(_) => break,
        };
        if write_all(private_pipe, &request).is_err() {
            break;
        }
        let response = match read_line(private_pipe) {
            Ok(value) => value,
            Err(_) => break,
        };
        if write_all(public_pipe, &response).is_err() {
            break;
        }
    }
    close_handle(public_pipe);
    close_handle(private_pipe);
}

fn base64url_decode(value: &str) -> Result<String, String> {
    let mut out = Vec::new();
    let mut accumulator = 0u32;
    let mut bits = 0u32;
    for byte in value.bytes() {
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62, b'_' => 63, _ => return Err("MCP_BROKER_BOOTSTRAP_INVALID".into()),
        } as u32;
        accumulator = (accumulator << 6) | digit;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((accumulator >> bits) as u8);
            accumulator &= (1u32 << bits).saturating_sub(1);
        }
    }
    String::from_utf8(out).map_err(|_| "MCP_BROKER_BOOTSTRAP_INVALID".into())
}

fn read_bootstrap() -> Result<Bootstrap, String> {
    let mut line = String::new();
    io::stdin().read_line(&mut line).map_err(|_| "MCP_BROKER_BOOTSTRAP_UNAVAILABLE".to_string())?;
    let fields: Vec<_> = line.trim_end_matches(['\r', '\n']).split('\t').collect();
    if fields.len() != 8 || fields[0] != MCP_EXTERNAL_BROKER_BOOTSTRAP_PROTOCOL {
        return Err("MCP_BROKER_BOOTSTRAP_INVALID".into());
    }
    let values = fields[1..].iter().map(|item| base64url_decode(item)).collect::<Result<Vec<_>, _>>()?;
    let bootstrap = Bootstrap {
        public_pipe_name: values[0].clone(), private_pipe_name: values[1].clone(), broker_secret: values[2].clone(),
        expected_proxy_executable_path: values[3].clone(), expected_proxy_executable_sha256: values[4].clone(),
        expected_proxy_path: values[5].clone(), expected_proxy_sha256: values[6].clone(),
    };
    if bootstrap.broker_secret.is_empty() || !bootstrap.expected_proxy_executable_sha256.chars().all(|ch| ch.is_ascii_hexdigit()) || bootstrap.expected_proxy_executable_sha256.len() != 64 || bootstrap.expected_proxy_sha256.len() != 64 || !bootstrap.expected_proxy_sha256.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("MCP_BROKER_BOOTSTRAP_INVALID".into());
    }
    if sha256_file(&bootstrap.expected_proxy_path)? != bootstrap.expected_proxy_sha256.to_lowercase() {
        return Err("MCP_BROKER_PROXY_RESOURCE_HASH_DENIED".into());
    }
    Ok(bootstrap)
}

// Electron keeps the bootstrap pipe open for the lifetime of the broker. If
// the parent exits unexpectedly, Windows closes the inherited stdin handle;
// exiting here releases the deterministic public pipe for the next launch.
fn watch_parent_stdin() {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut buffer = [0u8; 1024];
    loop {
        match input.read(&mut buffer) {
            Ok(0) | Err(_) => std::process::exit(0),
            Ok(_) => {}
        }
    }
}

fn run() -> Result<(), String> {
    let bootstrap = Arc::new(read_bootstrap()?);
    thread::spawn(watch_parent_stdin);
    let mut first_instance = true;
    loop {
        let pipe = create_public_pipe(&bootstrap.public_pipe_name, first_instance)?;
        first_instance = false;
        let connected = unsafe { ConnectNamedPipe(pipe, null_mut()) } != 0 || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
        if !connected { close_handle(pipe); continue; }
        let child_bootstrap = bootstrap.clone();
        let client_pipe = pipe as usize;
        thread::spawn(move || serve_client(client_pipe as Handle, child_bootstrap));
    }
}

fn main() {
    if let Err(code) = run() {
        let _ = writeln!(io::stderr(), "{}", code);
        std::process::exit(1);
    }
}
