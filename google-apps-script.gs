/**
 * Google Apps Script for Workflow Timer Timesheet Integration
 * Version: 2.0 - Multi-Month Support
 * 
 * SETUP INSTRUCTIONS:
 * 1. Open your Google Sheet
 * 2. Go to Extensions → Apps Script
 * 3. Delete any existing code and paste this entire script
 * 4. Click Deploy → New deployment
 * 5. Select "Web app" as the type
 * 6. Set "Who has access" to "Anyone"
 * 7. Click Deploy and copy the web app URL
 * 8. Paste the URL in Workflow Timer Settings → Script URL
 * 
 * SHEET NAMING CONVENTION:
 * - Turkish format: "Şubat 2026", "Mart 2026", etc.
 * - English format: "February 2026", "March 2026", etc.
 * - Script will automatically try both formats
 */

// Turkish month names
const MONTH_NAMES_TR = [
    "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
    "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"
];

// English month names (fallback)
const MONTH_NAMES_EN = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
];

/**
 * Get the appropriate sheet for a given date
 * Tries Turkish format first, then English, then falls back to active sheet
 */
function getSheetForDate(spreadsheet, date) {
    const month = date.getMonth(); // 0-11
    const year = date.getFullYear();
    
    // Try Turkish format first: "Şubat 2026"
    let sheetName = `${MONTH_NAMES_TR[month]} ${year}`;
    let sheet = spreadsheet.getSheetByName(sheetName);
    
    if (sheet) {
        Logger.log(`Found sheet with Turkish name: ${sheetName}`);
        return sheet;
    }
    
    // Try English format: "February 2026"
    sheetName = `${MONTH_NAMES_EN[month]} ${year}`;
    sheet = spreadsheet.getSheetByName(sheetName);
    
    if (sheet) {
        Logger.log(`Found sheet with English name: ${sheetName}`);
        return sheet;
    }
    
    // Fallback to active sheet (backward compatibility)
    Logger.log(`No month-specific sheet found, using active sheet`);
    return spreadsheet.getActiveSheet();
}

/**
 * Main POST handler - receives data from Workflow Timer
 */
function doPost(e) {
    try {
        const data = JSON.parse(e.postData.contents);
        const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
        
        // Determine target date
        // If client sends a date, use it; otherwise use current date
        let targetDate = new Date();
        if (data.date) {
            targetDate = new Date(data.date);
            Logger.log(`Using client-provided date: ${data.date}`);
        } else {
            Logger.log(`Using server date: ${targetDate.toISOString()}`);
        }
        
        // Get the appropriate sheet for this date
        const sheet = getSheetForDate(spreadsheet, targetDate);
        
        // Calculate row based on provided row or day of month
        let row;
        if (data.row) {
            row = data.row;
            Logger.log(`Using client-provided row: ${row}`);
        } else {
            // Fallback: calculate from date
            const dayOfMonth = targetDate.getDate();
            row = dayOfMonth + 1; // +1 to skip header row
            Logger.log(`Calculated row from date: ${row}`);
        }

        // Process each entry
        const results = [];
        data.entries.forEach(entry => {
            const { column, value, type } = entry;

            if (column && value !== undefined) {
                // Convert column letter to number (A=1, B=2, etc.)
                const colNum = columnLetterToNumber(column.toUpperCase());

                // Set the cell value
                sheet.getRange(row, colNum).setValue(value);

                results.push({
                    cell: `${column.toUpperCase()}${row}`,
                    value: value,
                    type: type,
                    status: 'success'
                });
                
                Logger.log(`Written to ${sheet.getName()}!${column.toUpperCase()}${row}: ${value}`);
            }
        });

        return ContentService
            .createTextOutput(JSON.stringify({ 
                success: true, 
                results, 
                row,
                sheetName: sheet.getName(),
                date: targetDate.toISOString()
            }))
            .setMimeType(ContentService.MimeType.JSON);

    } catch (error) {
        Logger.log(`Error: ${error.message}`);
        return ContentService
            .createTextOutput(JSON.stringify({ 
                success: false, 
                error: error.message,
                stack: error.stack
            }))
            .setMimeType(ContentService.MimeType.JSON);
    }
}

/**
 * GET handler - test endpoint to verify the script is working
 */
function doGet(e) {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const testDate = new Date();
    const sheet = getSheetForDate(spreadsheet, testDate);
    
    return ContentService
        .createTextOutput(JSON.stringify({
            success: true,
            message: 'Workflow Timer script is active!',
            version: '2.0',
            timestamp: testDate.toISOString(),
            currentSheet: sheet.getName(),
            availableSheets: spreadsheet.getSheets().map(s => s.getName())
        }))
        .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Convert column letter to number (A=1, B=2, AA=27, etc.)
 */
function columnLetterToNumber(letter) {
    let result = 0;
    for (let i = 0; i < letter.length; i++) {
        result = result * 26 + (letter.charCodeAt(i) - 64);
    }
    return result;
}

/**
 * Test function - run this manually to verify the script works
 * View results in: View → Logs
 */
function testScript() {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const testDate = new Date();
    
    Logger.log('=== Workflow Timer Script Test ===');
    Logger.log(`Test Date: ${testDate.toISOString()}`);
    Logger.log(`Month: ${MONTH_NAMES_TR[testDate.getMonth()]} ${testDate.getFullYear()}`);
    
    const sheet = getSheetForDate(spreadsheet, testDate);
    Logger.log(`Selected Sheet: ${sheet.getName()}`);
    
    const row = testDate.getDate() + 1;
    Logger.log(`Target Row: ${row}`);
    
    Logger.log('\nAvailable Sheets:');
    spreadsheet.getSheets().forEach(s => {
        Logger.log(`  - ${s.getName()}`);
    });
    
    Logger.log('\n=== Test Complete ===');
    Logger.log('If you see the correct sheet name above, the script is working correctly!');
}
