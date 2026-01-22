# Model List Fix - STMP

## Problem

The model list was not loading in the UI, showing the error:
```
Error: Invalid itemsObj for modelList {"embedding-gecko-001","gemini-2.5-flash",...}
```

### Root Cause

When API model lists were stored in the PostgreSQL database, they were being stored as stringified JavaScript Set objects (`{"model1","model2"}`) instead of proper JSON arrays (`["model1","model2"]`).

This happened because:
1. The `modelList` returned from `api.getModelList()` is a JavaScript array
2. When passed to `db.upsertAPI()`, it wasn't being explicitly JSON-stringified
3. PostgreSQL's `TEXT` column coerced the array to a string in an unexpected format
4. When retrieved, the client's `populateSelector()` function expected an array but received malformed JSON

## Solution

### 1. Updated Database Functions (src/db-pg.js)

**`upsertAPI()` function:**
- Added explicit JSON serialization of `modelList` before storing
- Handles both Arrays and Sets by converting to array first
- Line 955: `const modelListJson = modelList ? JSON.stringify(Array.isArray(modelList) ? modelList : Array.from(modelList)) : null;`

**`getAPIs()` function:**
- Added JSON parsing of `modelList` when retrieving from database
- Returns proper array format to client
- Lines 976-981

**`getAPI()` function:**
- Added JSON parsing of `modelList` for single API retrieval
- Lines 983-991

### 2. Created Fix Script (fix-modellist.js)

A utility script to repair existing corrupted data in the database:
- Scans all APIs for malformed `modelList` entries
- Detects Set-format strings (`{...}`) vs proper JSON arrays (`[...]`)
- Extracts model names and re-serializes as proper JSON
- Updates the database with correct format

## How to Apply the Fix

### For Fresh Installs
No action needed - the updated code will handle modelList correctly going forward.

### For Existing Databases with Corrupted Data

1. **Stop the STMP server** (close STMP.bat)

2. **Run the fix script:**
   ```bash
   node fix-modellist.js
   ```

3. **Restart the STMP server:**
   ```bash
   npm start
   # or run STMP.bat
   ```

4. **Refresh your browser** (Ctrl + Shift + R)

5. **Verify the fix:**
   - Go to Control Panel → API Config
   - Click "Refresh Model List"
   - Model dropdown should now populate correctly

## Verification

After applying the fix, the model list should:
- ✅ Load without errors in browser console
- ✅ Show all available models in the dropdown
- ✅ Allow model selection
- ✅ Persist selected model when refreshing

## Technical Details

### Database Schema
```sql
CREATE TABLE apis (
    name TEXT PRIMARY KEY,
    ...
    "modelList" TEXT,  -- Stores JSON-stringified array
    "selectedModel" TEXT
);
```

### Before Fix
```javascript
// Stored in database (WRONG):
"modelList": "{\"model1\",\"model2\",\"model3\"}"

// Retrieved by client (WRONG):
modelList = {"model1","model2","model3"}  // Not a valid array!

// populateSelector() check fails:
if (!Array.isArray(itemsObj)) {
    console.warn("Error: Invalid itemsObj for modelList", itemsObj);
}
```

### After Fix
```javascript
// Stored in database (CORRECT):
"modelList": "[\"model1\",\"model2\",\"model3\"]"

// Retrieved by client (CORRECT):
modelList = ["model1","model2","model3"]  // Valid array!

// populateSelector() check passes:
Array.isArray(itemsObj) === true ✅
```

## Files Modified

1. **src/db-pg.js** - Database functions for modelList serialization/deserialization
   - `upsertAPI()` - Lines 952-975
   - `getAPIs()` - Lines 976-981
   - `getAPI()` - Lines 983-991

2. **fix-modellist.js** - NEW utility script for repairing existing data

## Related Issues

This fix also resolves the secondary error:
```
Error: Invalid value for toggleCheckbox! undefined gemini undefined
```

This error occurred because the model list dropdown failed to populate, causing undefined references when trying to toggle API-specific checkboxes.

---

**Last Updated**: 2026-01-22
**Fix Version**: 1.0.0
**Database**: PostgreSQL
