/** Minimal RFC 4180 CSV reader for the upload preview (the server does the real parse). */
export function parseCsvPreview(text: string, maxRows = 5): { headers: string[]; rows: string[][]; rowCount: number } {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let rowCount = 0;
  const pushRecord = () => {
    record.push(field);
    field = "";
    if (record.length > 1 || record[0].trim() !== "") {
      rowCount++;
      if (records.length < maxRows + 1) records.push(record);
    }
    record = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      pushRecord();
    } else field += c;
  }
  if (field !== "" || record.length) pushRecord();
  const [headers = [], ...rows] = records;
  return { headers: headers.map((h) => h.trim()), rows, rowCount: Math.max(0, rowCount - 1) };
}
