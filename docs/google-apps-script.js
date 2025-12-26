/**
 * Google Apps Script for Workflow Timer Timesheet Integration
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
 */

function doPost(e) {
    try {
        const data = JSON.parse(e.postData.contents);
        const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

        // Calculate row: use provided row from client (local time based) or fallback to server time
        let row;
        if (data.row) {
            row = data.row;
        } else {
            // Fallback
            const today = new Date();
            const dayOfMonth = today.getDate();
            row = dayOfMonth + 1;
        }

        // Process each company's data
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
                    status: 'success'
                });
            }
        });

        return ContentService
            .createTextOutput(JSON.stringify({ success: true, results, row }))
            .setMimeType(ContentService.MimeType.JSON);

    } catch (error) {
        return ContentService
            .createTextOutput(JSON.stringify({ success: false, error: error.message }))
            .setMimeType(ContentService.MimeType.JSON);
    }
}

function doGet(e) {
    // Test endpoint to verify the script is working
    return ContentService
        .createTextOutput(JSON.stringify({
            success: true,
            message: 'Workflow Timer script is active!',
            timestamp: new Date().toISOString()
        }))
        .setMimeType(ContentService.MimeType.JSON);
}

function columnLetterToNumber(letter) {
    let result = 0;
    for (let i = 0; i < letter.length; i++) {
        result = result * 26 + (letter.charCodeAt(i) - 64);
    }
    return result;
}

// Test function - run this to verify the script works
function testScript() {
    const testData = {
        entries: [
            { column: 'B', value: 8.5, type: 'hours' },
            { column: 'H', value: 'Test note', type: 'note' }
        ]
    };

    Logger.log('Test data: ' + JSON.stringify(testData));
    Logger.log('This would write to row: ' + (new Date().getDate() + 1));
}
