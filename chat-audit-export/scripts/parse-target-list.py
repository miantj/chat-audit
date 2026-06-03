#!/usr/bin/env python3
import argparse
import csv
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"


def normalize_header(value):
    return re.sub(r"\s+", "", str(value or "").strip()).lower()


def normalize_owner(value):
    return re.sub(r"\s+", "", str(value or "").strip()).lower()


def cell_ref_to_col(ref):
    match = re.match(r"([A-Z]+)", ref or "")
    if not match:
        return 0
    col = 0
    for char in match.group(1):
        col = col * 26 + (ord(char) - ord("A") + 1)
    return col - 1


def read_shared_strings(zf):
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    strings = []
    for si in root.findall(f"{{{MAIN_NS}}}si"):
        strings.append("".join((t.text or "") for t in si.iter(f"{{{MAIN_NS}}}t")))
    return strings


def read_sheet_map(zf):
    workbook = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    rel_targets = {
        rel.attrib.get("Id"): rel.attrib.get("Target", "")
        for rel in rels.findall(f"{{{PKG_REL_NS}}}Relationship")
    }
    sheets = []
    for sheet in workbook.findall(f".//{{{MAIN_NS}}}sheet"):
        rel_id = sheet.attrib.get(f"{{{REL_NS}}}id")
        target = rel_targets.get(rel_id, "")
        if target and not target.startswith("/"):
            target = f"xl/{target}"
        if target.startswith("/"):
            target = target.lstrip("/")
        target = os.path.normpath(target).replace("\\", "/")
        sheets.append({
            "name": sheet.attrib.get("name", ""),
            "path": target
        })
    return sheets


def read_xlsx_rows(file_path, sheet_name):
    with zipfile.ZipFile(file_path) as zf:
        shared_strings = read_shared_strings(zf)
        sheets = read_sheet_map(zf)
        if not sheets:
            raise ValueError("Excel workbook does not contain any worksheets.")

        selected = None
        if sheet_name:
            selected = next((item for item in sheets if item["name"] == sheet_name), None)
            if selected is None:
                names = ", ".join(item["name"] for item in sheets)
                raise ValueError(f"Worksheet not found: {sheet_name}. Available sheets: {names}")
        else:
            selected = sheets[0]

        root = ET.fromstring(zf.read(selected["path"]))
        rows = []
        for row in root.findall(f".//{{{MAIN_NS}}}row"):
            values = []
            for cell in row.findall(f"{{{MAIN_NS}}}c"):
                col_index = cell_ref_to_col(cell.attrib.get("r", ""))
                while len(values) <= col_index:
                    values.append("")
                value_node = cell.find(f"{{{MAIN_NS}}}v")
                inline_node = cell.find(f"{{{MAIN_NS}}}is")
                value = ""
                if value_node is not None and value_node.text is not None:
                    value = value_node.text
                    if cell.attrib.get("t") == "s":
                        value = shared_strings[int(value)]
                elif inline_node is not None:
                    value = "".join((t.text or "") for t in inline_node.iter(f"{{{MAIN_NS}}}t"))
                values[col_index] = str(value).strip()
            rows.append(values)
        return selected["name"], rows


def read_csv_rows(file_path):
    with open(file_path, "r", encoding="utf-8-sig", newline="") as fh:
        return "", [[str(value).strip() for value in row] for row in csv.reader(fh)]


def find_column(headers, names):
    normalized_headers = [normalize_header(header) for header in headers]
    normalized_names = [normalize_header(name) for name in names]
    for name in normalized_names:
        if name in normalized_headers:
            return normalized_headers.index(name)
    return -1


def parse_targets(file_path, sheet_name=""):
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Target list file not found: {file_path}")

    ext = os.path.splitext(file_path)[1].lower()
    if ext == ".xlsx":
        resolved_sheet_name, rows = read_xlsx_rows(file_path, sheet_name)
    elif ext == ".csv":
        resolved_sheet_name, rows = read_csv_rows(file_path)
    else:
        raise ValueError("Unsupported target list file type. Use .xlsx or .csv.")

    non_empty_rows = [row for row in rows if any(str(value).strip() for value in row)]
    if not non_empty_rows:
        raise ValueError("Target list file is empty.")

    headers = non_empty_rows[0]
    owner_col = find_column(headers, ["负责人", "顾问", "客服", "员工", "员工姓名"])
    customer_col = find_column(headers, ["外部客户ID", "外部客户id", "客户ID", "客户id", "用户ID", "用户id"])
    if owner_col < 0:
        raise ValueError("Target list is missing owner column: 负责人")
    if customer_col < 0:
        raise ValueError("Target list is missing customer ID column: 外部客户ID")

    targets = []
    skipped_rows = []
    duplicate_rows = []
    seen = set()
    for offset, row in enumerate(non_empty_rows[1:], start=2):
        owner_name = row[owner_col].strip() if owner_col < len(row) else ""
        customer_id = row[customer_col].strip() if customer_col < len(row) else ""
        if not owner_name and not customer_id:
            continue
        if not owner_name or not customer_id:
            skipped_rows.append({
                "row_number": offset,
                "owner_name": owner_name,
                "customer_id": customer_id,
                "reason": "missing owner or customer id"
            })
            continue

        normalized_owner_name = normalize_owner(owner_name)
        key = f"{normalized_owner_name}\0{customer_id}"
        source_info = f"负责人={owner_name}; 外部客户ID={customer_id}; row={offset}"
        source_row = {
            "source": "target_file",
            "file_path": os.path.abspath(file_path),
            "sheet_name": resolved_sheet_name or None,
            "row_number": offset,
            "owner_name": owner_name,
            "normalized_owner_name": normalized_owner_name,
            "customer_id": customer_id
        }
        if key in seen:
            duplicate_rows.append(source_row)
            continue
        seen.add(key)
        targets.append({
            "employeeName": owner_name,
            "ownerName": owner_name,
            "normalizedOwnerName": normalized_owner_name,
            "customerId": customer_id,
            "metricCategory": "target_file",
            "metricPage": offset,
            "customerInfo": source_info,
            "sourceMetricCategories": ["target_file"],
            "metricRows": [source_row],
            "sourceFile": os.path.abspath(file_path),
            "sourceSheet": resolved_sheet_name or None,
            "sourceRowNumber": offset
        })

    if not targets:
        raise ValueError("Target list does not contain any valid owner/customer pairs.")

    owner_names = []
    owner_seen = set()
    for target in targets:
        if target["normalizedOwnerName"] in owner_seen:
            continue
        owner_seen.add(target["normalizedOwnerName"])
        owner_names.append(target["ownerName"])

    return {
        "filePath": os.path.abspath(file_path),
        "sheetName": resolved_sheet_name or None,
        "totalDataRows": max(len(non_empty_rows) - 1, 0),
        "targetCount": len(targets),
        "ownerCount": len(owner_names),
        "ownerNames": owner_names,
        "targets": targets,
        "skippedRows": skipped_rows,
        "duplicateRows": duplicate_rows
    }


def main():
    parser = argparse.ArgumentParser(description="Parse CRM chat audit target lists.")
    parser.add_argument("--file", required=True)
    parser.add_argument("--sheet", default="")
    args = parser.parse_args()
    try:
        result = parse_targets(args.file, args.sheet)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
