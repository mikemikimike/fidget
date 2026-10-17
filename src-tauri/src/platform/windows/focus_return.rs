//! Give the keyboard back after a quick message pill closes: to the
//! window that had the foreground before, or the topmost other window, sent
//! via SetForegroundWindow. Traced first under FIDGET_TRACE_FRAMES to probe
//! foreground lock behavior on Windows (#1565).

use std::sync::atomic::{AtomicIsize, Ordering};

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetTopWindow, GetWindow, GetWindowLongPtrW, GetWindowThreadProcessId,
    IsWindow, IsWindowVisible, SetForegroundWindow, GWL_EXSTYLE, GW_HWNDNEXT, WS_EX_TOOLWINDOW,
};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};

use crate::pill_focus::{hand_back, HandBack};

/// The foreground window when a pill took the keyboard; 0 is none.
static FOREGROUND_BEFORE_PILL: AtomicIsize = AtomicIsize::new(0);

/// Remember the foreground window before a pill takes the keyboard.
pub fn remember_foreground(hwnd: HWND) {
    FOREGROUND_BEFORE_PILL.store(hwnd as isize, Ordering::Relaxed);
    
    if crate::dev_flags::TRACE_FRAMES.is_on() {
        eprintln!(
            "FOREGROUND_BEFORE_PILL: remembered hwnd={:#x}",
            hwnd as usize
        );
    }
}

/// One window in the z-order walk, with the criteria `next_window_in_front` needs.
struct Candidate {
    ours: bool,
    visible: bool,
    tool: bool,
    cloaked: bool,
}

/// Where a step aside hands the foreground: the first window in z-order that
/// is not Fidget's, is visible, and is neither a tool window nor cloaked.
fn next_in_front(z_order: &[Candidate]) -> Option<usize> {
    z_order
        .iter()
        .position(|w| !w.ours && w.visible && !w.tool && !w.cloaked)
}

/// The topmost window that is not Fidget's, is visible, and is neither a tool
/// window nor cloaked (another virtual desktop, a suspended UWP app).
/// Uses `windows_perch::perch_candidate` for the visibility/tool check.
fn next_window_in_front() -> Option<HWND> {
    let ours = std::process::id();
    let mut windows = Vec::new();
    let mut z_order = Vec::new();
    
    // SAFETY: read-only Win32 queries on handles Windows just listed; a window
    // that closes mid-walk answers with zeros and is skipped.
    unsafe {
        let mut hwnd = GetTopWindow(std::ptr::null_mut());
        while !hwnd.is_null() && windows.len() < 4096 {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            let mut cloaked = 0u32;
            let cloak_read = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED as _,
                (&mut cloaked as *mut u32).cast(),
                std::mem::size_of::<u32>() as u32,
            );
            
            let visible = IsWindowVisible(hwnd) != 0;
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let tool = (ex_style & WS_EX_TOOLWINDOW) != 0;
            
            z_order.push(Candidate {
                ours: pid == ours,
                visible,
                tool,
                cloaked: cloak_read >= 0 && cloaked != 0,
            });
            windows.push(hwnd);
            hwnd = GetWindow(hwnd, GW_HWNDNEXT);
        }
    }
    
    next_in_front(&z_order).map(|i| windows[i])
}

/// The overlay's last pill closed: give the foreground back to the window
/// that had it, if the overlay still holds it and that window still exists.
pub fn hand_back_keyboard(overlay: HWND) -> Result<(), String> {
    let previous = FOREGROUND_BEFORE_PILL.swap(0, Ordering::Relaxed) as HWND;
    
    // SAFETY: Win32 queries on window handles; IsWindow vets the remembered one.
    unsafe {
        let foreground_before = GetForegroundWindow();
        let holding = foreground_before == overlay;
        let alive = !previous.is_null() && IsWindow(previous) != 0;
        
        let decision = hand_back(holding, alive);
        
        if crate::dev_flags::TRACE_FRAMES.is_on() {
            eprintln!(
                "hand_back: decision={decision:?} holding={holding} (foreground={:#x} overlay={:#x}) previous={:#x} alive={alive}",
                foreground_before as usize, overlay as usize, previous as usize
            );
        }
        
        match decision {
            HandBack::Restore => {
                let result = SetForegroundWindow(previous);
                let foreground_after = GetForegroundWindow();
                
                if crate::dev_flags::TRACE_FRAMES.is_on() {
                    eprintln!(
                        "hand_back Restore: SetForegroundWindow({:#x}) returned {} (zero=fail), GetForegroundWindow()={:#x}",
                        previous as usize, result, foreground_after as usize
                    );
                }
            }
            HandBack::StepAside => {
                if let Some(next) = next_window_in_front() {
                    let result = SetForegroundWindow(next);
                    let foreground_after = GetForegroundWindow();
                    
                    if crate::dev_flags::TRACE_FRAMES.is_on() {
                        eprintln!(
                            "hand_back StepAside: SetForegroundWindow({:#x}) returned {} (zero=fail), GetForegroundWindow()={:#x}",
                            next as usize, result, foreground_after as usize
                        );
                    }
                }
            }
            HandBack::Stay => {
                if crate::dev_flags::TRACE_FRAMES.is_on() {
                    eprintln!("hand_back Stay: no action taken");
                }
            }
        }
    }
    
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    
    fn window(ours: bool, visible: bool, tool: bool, cloaked: bool) -> Candidate {
        Candidate {
            ours,
            visible,
            tool,
            cloaked,
        }
    }
    
    #[test]
    fn a_step_aside_skips_fidget_hidden_tool_and_cloaked_windows() {
        let z_order = [
            window(true, true, false, false),
            window(false, false, false, false),
            window(false, true, true, false),
            window(false, true, false, true),
            window(false, true, false, false),
            window(false, true, false, false),
        ];
        assert_eq!(next_in_front(&z_order), Some(4));
        assert_eq!(next_in_front(&z_order[..4]), None);
    }
}
