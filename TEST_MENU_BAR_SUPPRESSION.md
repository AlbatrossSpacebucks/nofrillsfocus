# Menu Bar Suppression Validation Test Plan

## Test Build
- Version: 0.1.7
- Build: `No Frills Focus-0.1.7-arm64-mac.zip`
- Date: 2026-01-20

## Changes Under Test
- `applyMenuBarSuppression()` helper added
- Applied to all BrowserWindow instances at 3 lifecycle stages
- System switch: `disable-features=MacMenuBarAutoHide`
- Per-window: `setAutoHideMenuBar(true)` + `setMenuBarVisibility(false)`

---

## Test Protocol

### Display Configuration

**System Preferences → Displays → Resolution**

Test each of these scaled resolutions:
- [ ] 1440 × 900
- [ ] 1680 × 1050
- [ ] 1280 × 800 (if available)

### Window Mode Variants

For each resolution, test:
- [ ] Single Space (no fullscreen apps)
- [ ] Multiple Spaces (at least one fullscreen app on another Space)

---

## Test Cases

### Test 1: Menu Bar Visibility (CRITICAL)

**Steps:**
1. Set display to test resolution
2. Launch No Frills Focus
3. Grant accessibility permission (if needed)
4. Select any app with a window (e.g., Safari, Notes)
5. Start session (any duration)
6. **Observe top edge of screen**

**PASS Criteria:**
- ✅ No bright white/blue menu bar sliver
- ✅ No menu icons/text on hover at top edge
- ✅ If any UI visible, it's faint/non-distracting

**FAIL Criteria:**
- ❌ Bright bar at top
- ❌ Clear menu icons appearing
- ❌ Notch-adjacent UI peeking through

**Result:**
```
Resolution: _______
Menu bar: PASS / FAIL
Notes: _______________________________
```

---

### Test 2: Picker Window Clipping

**Steps:**
1. Launch picker (Cmd+Shift+L or initial launch)
2. **Observe right edge of picker window**
3. Check if duration dropdown and buttons are fully visible

**PASS Criteria:**
- ✅ Picker content fully visible
- ✅ No right-edge clipping
- ✅ Dropdown overflow acceptable

**FAIL Criteria:**
- ❌ UI cut off on right
- ❌ Text/controls clipped

**Result:**
```
Resolution: _______
Picker: PASS / FAIL
Notes: _______________________________
```

---

### Test 3: Enforcement Consistency

**Steps:**
1. During active session, attempt to:
   - Click outside opening
   - Cmd+Tab to another app
   - Move cursor to dock area
2. Press Cmd+Shift+X to end session
3. Press Cmd+Shift+Z (should emergency quit)

**PASS Criteria:**
- ✅ Focus cannot escape
- ✅ Shortcuts work
- ✅ No flicker or focus stealing

**FAIL Criteria:**
- ❌ Can interact with masked area
- ❌ Shortcuts broken
- ❌ New visual glitches

**Result:**
```
Enforcement: PASS / FAIL
Notes: _______________________________
```

---

## Consolidated Results Template

```
=== MENU BAR SUPPRESSION TEST RESULTS ===

Resolution: 1440×900
Menu bar: PASS / FAIL
Picker: PASS / FAIL
Notes: 

Resolution: 1680×1050
Menu bar: PASS / FAIL
Picker: PASS / FAIL
Notes: 

Resolution: 1280×800
Menu bar: PASS / FAIL
Picker: PASS / FAIL
Notes: 

Enforcement: PASS / FAIL

=== STOP CONDITIONS ===
[ ] Menu bar sliver persists across ALL resolutions → STOP, report failure
[ ] All tests PASS → Proceed with commit
```

---

## Log Inspection (Optional)

Check `/tmp/nff.log` for:
```
[MENUBAR] suppression applied to window
```

Should appear:
- At picker creation
- At modal creation
- At each mask creation (5×)
- At corner patch creation (if enabled, 4×)

Expected count per session: ~10-12 lines minimum
