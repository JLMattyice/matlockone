/**
 * Reading a spreadsheet that was saved as CSV.
 *
 * Runs in the browser, to show what a file holds before anything is saved,
 * and again on the server, which never trusts the browser's reading of it.
 * So it is plain code with no imports.
 *
 * Small businesses' files come from everywhere — Excel, Google Sheets,
 * QuickBooks, another app's export, a list somebody typed in 2014 — so this
 * reads what those actually produce rather than only the textbook format:
 * semicolons or tabs instead of commas, Excel's `sep=` first line, a byte-order
 * mark, quoted cells with line breaks in them, and older Excel's Windows-1252
 * text.
 */

/**
 * Text from a file's bytes.
 *
 * UTF-8 when the bytes are valid UTF-8, UTF-16 when Excel's "Unicode Text"
 * marked them so, and otherwise Windows-1252 — what older Excel writes on a
 * Windows PC. Decoding that as UTF-8 would turn every "é" into a "�".
 */
export function decodeCsvBytes(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }

  try {
    return stripBom(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function stripBom(text: string) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * The separators worth considering, in the order a tie goes: a tab or a
 * semicolon in a heading is rare, a comma in one ("City, State") is not.
 */
const DELIMITERS = ["\t", ";", ","] as const;

/**
 * Which character separates the cells: whichever of tab, semicolon and comma
 * appears most often in the first line, outside quotes. A European Excel saves
 * "CSV" with semicolons; a copy from a spreadsheet is tab-separated.
 */
function detectDelimiter(text: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) break;
    else if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1);
  }

  let best = ",";
  let most = 0;
  for (const delimiter of DELIMITERS) {
    if (counts.get(delimiter)! > most) {
      best = delimiter;
      most = counts.get(delimiter)!;
    }
  }
  return best;
}

/**
 * The file as rows of cells, exactly as written (not trimmed).
 *
 * Rows with nothing in them are left out — a spreadsheet saved with blank rows
 * at the bottom is the normal case, not an error.
 */
export function parseCsv(input: string): string[][] {
  let text = stripBom(input);

  // Excel's way of saying which separator follows: a first line of "sep=;".
  let delimiter: string;
  const declared = /^sep=(.)\r?\n/i.exec(text);
  if (declared) {
    delimiter = declared[1];
    text = text.slice(declared[0].length);
  } else {
    delimiter = detectDelimiter(text);
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  const endRow = () => {
    row.push(cell);
    if (row.some((value) => value.trim() !== "")) rows.push(row);
    row = [];
    cell = "";
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside quotes is one quote character.
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"' && cell.trim() === "") {
      cell = "";
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      cell += char;
    }
  }

  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

/** One cell as CSV, quoted only when it has to be. */
export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Rows as a CSV file's text, with Windows line endings so Excel is happy. */
export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
