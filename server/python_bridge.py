"""Python services reused by the React/Express application.

Input and output are JSON over stdin/stdout so credentials and Mongo access stay
in the Node API. Heavy PDF work uses focused Python PDF libraries.
"""

import base64
import io
import json
import re
import sys
from datetime import date, datetime
from html import escape as html_escape
from urllib.parse import quote

def clean(value):
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def amount(value):
    try:
        return float(str(value or "0").replace(",", ""))
    except (TypeError, ValueError):
        return 0.0


def extract_text(pdf_bytes):
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as document:
            return "\n".join(page.extract_text(x_tolerance=1, y_tolerance=3) or "" for page in document.pages)
    except ImportError:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(pdf_bytes))
        return "\n".join(page.extract_text() or "" for page in reader.pages)


def extract_tables(pdf_bytes):
    try:
        import pdfplumber
    except ImportError:
        return []
    rows = []
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as document:
            for page in document.pages:
                for table in page.extract_tables() or []:
                    for row in table or []:
                        values = [clean(cell) for cell in (row or [])]
                        if any(values):
                            rows.append(values)
    except Exception:
        return []
    return rows


def field(text, pattern):
    match = re.search(pattern, text, flags=re.IGNORECASE)
    return clean(match.group(1)) if match else ""


def transaction_name(description):
    desc = re.sub(r"^(TO|BY)\s+", "", clean(description), flags=re.IGNORECASE).strip()
    parts = [clean(part) for part in desc.split("/")]
    if len(parts) >= 4 and parts[1].upper() in {"DR", "CR"}:
        return parts[3] or "Unknown"
    if ":" in desc:
        return clean(desc.split(":", 1)[0]) or "Unknown"
    return desc[:60] or "Unknown"


def transaction_row(txn_date, description, debit="", credit="", balance=""):
    txn_date, description = clean(txn_date), clean(description)
    if not re.match(r"^\d{2}/\d{2}/\d{4}$", txn_date):
        return None
    if not re.match(r"^(TO|BY)\b", description, flags=re.IGNORECASE):
        return None
    return {
        "Date": txn_date,
        "Name": transaction_name(description),
        "Description": description,
        "Debit": amount(debit),
        "Credit": amount(credit),
        "Balance": amount(balance),
    }


def table_transactions(table_rows):
    amount_re = re.compile(r"^\d{1,3}(?:,\d{3})*(?:\.\d{2})$|^\d+(?:\.\d{2})$")
    rows = []
    for raw in table_rows:
        cells = [clean(cell) for cell in raw]
        if len(cells) < 2 or cells[0].upper() == "DATE" or cells[1].upper() == "DESCRIPTION":
            continue
        amounts = [cell for cell in cells[2:] if amount_re.match(cell)]
        txn_amount = amounts[0] if len(amounts) >= 2 else ""
        balance = amounts[-1] if amounts else ""
        direction = cells[1].split(" ", 1)[0].upper() if cells[1] else ""
        parsed = transaction_row(cells[0], cells[1], txn_amount if direction == "TO" else "", txn_amount if direction == "BY" else "", balance)
        if parsed:
            rows.append(parsed)
    return rows


def text_transactions(text):
    number = r"\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+(?:\.\d{2})"
    row_re = re.compile(rf"^(\d{{2}}/\d{{2}}/\d{{4}})\s+(TO|BY)\s+(.+?)\s+({number})\s+({number})$", re.IGNORECASE)
    rows = []
    for raw in text.splitlines():
        match = row_re.match(clean(raw))
        if not match:
            continue
        txn_date, direction, description, txn_amount, balance = match.groups()
        direction = direction.upper()
        parsed = transaction_row(txn_date, f"{direction} {description}", txn_amount if direction == "TO" else "", txn_amount if direction == "BY" else "", balance)
        if parsed:
            rows.append(parsed)
    return rows


def merge_transactions(*groups):
    result, seen = [], set()
    for group in groups:
        for row in group:
            key = (row["Date"], row["Description"], round(row["Debit"], 2), round(row["Credit"], 2), round(row["Balance"], 2))
            if key not in seen:
                seen.add(key)
                result.append(row)
    return result


def parse_passbook(file_data):
    pdf_bytes = base64.b64decode(file_data["base64"])
    text = extract_text(pdf_bytes)
    tables = extract_tables(pdf_bytes)
    lines = [clean(line) for line in text.splitlines() if clean(line)]
    customer_name = re.sub(r"\s*\.$", "", field(text, r"CUSTOMER\s+DETAILS\s*:\s*(.+)")).strip()
    address_lines = []
    for index, line in enumerate(lines):
        if re.search(r"CUSTOMER\s+DETAILS\s*:", line, flags=re.IGNORECASE):
            for next_line in lines[index + 1:]:
                if re.search(r"^(Statement Date|STATEMENT OF ACCOUNT|DATE DESCRIPTION)", next_line, flags=re.IGNORECASE):
                    break
                address_lines.append(next_line)
            break
    branch_address = ""
    for index, line in enumerate(lines):
        if re.search(r"^BRANCH\s*:", line, flags=re.IGNORECASE) and index + 1 < len(lines):
            candidate = lines[index + 1]
            if not re.search(r"^(ACCOUNT|IFSC|CUSTOMER|STATEMENT)", candidate, flags=re.IGNORECASE):
                branch_address = candidate
            break
    transactions = merge_transactions(table_transactions(tables), text_transactions(text))
    return {
        "filename": file_data.get("filename", "passbook.pdf"),
        "bank": lines[0] if lines else "",
        "branch": field(text, r"BRANCH\s*:\s*(.+)"),
        "branch_address": branch_address,
        "account_no": field(text, r"ACCOUNT\s+NO\s*:\s*([^\n]+)"),
        "account_no_15": field(text, r"ACCOUNT\s+NO\(15\s+DIGIT\)\s*:\s*([^\n]+)"),
        "ifsc": field(text, r"IFSC\s*:\s*([^\n]+)"),
        "account_type": field(text, r"ACCOUNT\s+TYPE\s*:\s*([^\n]*)"),
        "customer_name": customer_name or file_data.get("filename", "Unknown"),
        "address": ", ".join(address_lines),
        "statement_date": field(text, r"Statement\s+Date\s*:\s*([^\n]+)"),
        "statement_period": field(text, r"STATEMENT\s+OF\s+ACCOUNT\s+from\s+(.+)"),
        "transactions": transactions,
        "total_debit": sum(row["Debit"] for row in transactions),
        "total_credit": sum(row["Credit"] for row in transactions),
        "latest_balance": transactions[-1]["Balance"] if transactions else 0.0,
        "raw_text": text[:100000],
    }


def upi_qr(pending, upi_id, brand_name):
    import qrcode
    uri = f"upi://pay?pa={quote(upi_id)}&pn={quote(brand_name)}&cu=INR"
    if pending > 0:
        uri += f"&am={pending:.2f}"
    qr = qrcode.QRCode(box_size=8, border=2)
    qr.add_data(uri)
    qr.make(fit=True)
    output = io.BytesIO()
    qr.make_image(fill_color="black", back_color="white").save(output, format="PNG")
    output.seek(0)
    return output


def display_date(value):
    value = str(value or "")[:10]
    try:
        return datetime.strptime(value, "%Y-%m-%d").strftime("%d %b %Y")
    except ValueError:
        return value or "-"


def paid_date(row):
    return display_date(row.get("last_payment_date") or row.get("payment_date")) if (row.get("last_payment_date") or row.get("payment_date")) else "-"


def generate_bill(payload):
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    rows = payload["sales"]
    customer = payload["customer_name"]
    bill_id = payload["bill_id"]
    bill_date = payload.get("bill_date") or str(date.today())
    scope_label = payload.get("bill_scope_label") or "All Transactions"
    business_name = clean(payload.get("business_name")) or "Boutique Cloud"
    business_logo = clean(payload.get("business_logo"))
    store_credit = max(0, amount(payload.get("store_credit")))
    upi_id = clean(payload.get("upi_id"))
    total_bill = sum(amount(row.get("selling_price")) for row in rows)
    total_paid = sum(amount(row.get("amount_paid")) for row in rows)
    total_pending = sum(amount(row.get("pending_amount")) for row in rows)
    phone = next((clean(row.get("customer_phone")) for row in rows if clean(row.get("customer_phone"))), "")

    output = io.BytesIO()
    document = SimpleDocTemplate(output, pagesize=A4, rightMargin=14*mm, leftMargin=14*mm, topMargin=12*mm, bottomMargin=12*mm, title=f"Bill - {customer}")
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("BillTitle", parent=styles["Title"], fontName="Helvetica-Bold", fontSize=20, leading=24, textColor=colors.HexColor("#0F172A"), spaceAfter=4)
    sub_style = ParagraphStyle("BillSub", parent=styles["Normal"], fontSize=9, leading=12, textColor=colors.HexColor("#475569"))
    right_style = ParagraphStyle("Right", parent=styles["Normal"], fontSize=9, alignment=TA_RIGHT, textColor=colors.HexColor("#475569"))
    center_style = ParagraphStyle("Center", parent=styles["Normal"], fontSize=9, alignment=TA_CENTER, textColor=colors.HexColor("#0F172A"))
    story = []
    initials = "".join(word[0] for word in business_name.split()[:2]).upper() or "BC"
    symbol = Paragraph(f"<b>{html_escape(initials)}</b>", center_style)
    if business_logo.startswith("data:image/") and ";base64," in business_logo:
        try:
            symbol = Image(io.BytesIO(base64.b64decode(business_logo.split(",", 1)[1])), width=20*mm, height=20*mm, kind="proportional")
        except Exception:
            pass
    brand = Table([[symbol, [Paragraph(html_escape(business_name), title_style), Paragraph("Customer Purchase Bill", sub_style)]]], colWidths=[24*mm, 88*mm])
    brand.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"MIDDLE"),("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),6),("TOPPADDING",(0,0),(-1,-1),0),("BOTTOMPADDING",(0,0),(-1,-1),0)]))
    header_details = [Paragraph(f"<b>Bill ID:</b> {html_escape(bill_id)}",right_style),Paragraph(f"<b>Bill Date:</b> {display_date(bill_date)}",right_style)]
    if upi_id:
        header_details.append(Paragraph(f"<b>UPI:</b> {html_escape(upi_id)}",right_style))
    header = Table([[brand, header_details]], colWidths=[112*mm,56*mm])
    header.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"TOP"),("BOTTOMPADDING",(0,0),(-1,-1),8),("LINEBELOW",(0,0),(-1,-1),.6,colors.HexColor("#CBD5E1"))]))
    story.extend([header, Spacer(1,8)])
    customer_block = Table([[Paragraph(f"<b>Customer:</b> {html_escape(customer)}",sub_style),Paragraph(f"<b>Phone:</b> {html_escape(phone or '-')}",sub_style),Paragraph(f"<b>Bill ID:</b> {html_escape(bill_id)}",sub_style),Paragraph(f"<b>Type:</b> {html_escape(scope_label)}",sub_style)]],colWidths=[54*mm,36*mm,42*mm,36*mm])
    customer_block.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,-1),colors.HexColor("#F8FAFC")),("BOX",(0,0),(-1,-1),.6,colors.HexColor("#DBEAFE")),("INNERGRID",(0,0),(-1,-1),.3,colors.HexColor("#E2E8F0")),("PADDING",(0,0),(-1,-1),7)]))
    story.extend([customer_block,Spacer(1,10),Paragraph("Bill Contents",ParagraphStyle("Section",parent=styles["Heading2"],fontSize=12,textColor=colors.HexColor("#0F172A"),spaceAfter=6))])
    table_data = [["Date","Item / Category","Bill","Paid","Paid Date","Status"]]
    for row in rows:
        description = clean(row.get("product_description")) or clean(row.get("product_category")) or "-"
        category = clean(row.get("product_category"))
        item = f"{html_escape(description)}<br/><font color='#64748B'>{html_escape(category)}</font>"
        pending = amount(row.get("pending_amount"))
        table_data.append([display_date(row.get("sale_date")),Paragraph(item,sub_style),f"Rs {amount(row.get('selling_price')):,.2f}",f"Rs {amount(row.get('amount_paid')):,.2f}",paid_date(row),"PAID [x]" if pending<=0 else "PENDING"])
    purchase_table = Table(table_data,colWidths=[22*mm,76*mm,22*mm,22*mm,25*mm,22*mm],repeatRows=1)
    purchase_table.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,0),colors.HexColor("#EAF1FF")),("TEXTCOLOR",(0,0),(-1,0),colors.HexColor("#0F172A")),("FONTNAME",(0,0),(-1,0),"Helvetica-Bold"),("FONTSIZE",(0,0),(-1,-1),8),("GRID",(0,0),(-1,-1),.35,colors.HexColor("#CBD5E1")),("VALIGN",(0,0),(-1,-1),"TOP"),("ALIGN",(2,1),(3,-1),"RIGHT"),("ALIGN",(5,1),(5,-1),"CENTER"),("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white,colors.HexColor("#F8FAFC")]),("PADDING",(0,0),(-1,-1),5)]))
    story.extend([purchase_table,Spacer(1,10)])
    if upi_id:
        payment_block = [Image(upi_qr(total_pending, upi_id, business_name),width=34*mm,height=34*mm),[Paragraph("<b>UPI Payment</b>",sub_style),Paragraph(f"UPI ID: {html_escape(upi_id)}",sub_style),Paragraph(f"QR amount: Rs {total_pending:,.2f}" if total_pending>0 else "No pending amount",sub_style)]]
        totals = Table([[*payment_block,[Paragraph(f"<b>Total Bill:</b> Rs {total_bill:,.2f}",right_style),Paragraph(f"<b>Total Paid:</b> Rs {total_paid:,.2f}",right_style),Paragraph(f"<b>Total Pending:</b> Rs {total_pending:,.2f}",right_style),Paragraph(f"<b>Store Credit:</b> Rs {store_credit:,.2f}",right_style)]]],colWidths=[38*mm,62*mm,68*mm])
    else:
        totals = Table([[Paragraph("Payment summary",sub_style),[Paragraph(f"<b>Total Bill:</b> Rs {total_bill:,.2f}",right_style),Paragraph(f"<b>Total Paid:</b> Rs {total_paid:,.2f}",right_style),Paragraph(f"<b>Total Pending:</b> Rs {total_pending:,.2f}",right_style),Paragraph(f"<b>Store Credit:</b> Rs {store_credit:,.2f}",right_style)]]],colWidths=[100*mm,68*mm])
    totals.setStyle(TableStyle([("BOX",(0,0),(-1,-1),.7,colors.HexColor("#CBD5E1")),("BACKGROUND",(0,0),(-1,-1),colors.HexColor("#F8FAFC")),("VALIGN",(0,0),(-1,-1),"MIDDLE"),("PADDING",(0,0),(-1,-1),8)]))
    story.extend([totals,Spacer(1,8)])
    if total_pending>0:
        story.append(Paragraph(f"Pending amount to be paid: <b>Rs {total_pending:,.2f}</b>",ParagraphStyle("Pending",parent=center_style,fontSize=10,textColor=colors.HexColor("#B91C1C"))))
    else:
        story.append(Paragraph("All listed purchases are paid.",ParagraphStyle("Paid",parent=center_style,fontSize=10,textColor=colors.HexColor("#047857"))))
    document.build(story)
    return {"pdf_base64": base64.b64encode(output.getvalue()).decode(),"total_bill":total_bill,"total_paid":total_paid,"total_pending":total_pending,"store_credit":store_credit,"customer_phone":phone}


def main():
    request = json.load(sys.stdin)
    action, payload = request.get("action"), request.get("payload") or {}
    if action == "parse_passbooks":
        result = {"passbooks": [parse_passbook(item) for item in payload.get("files", [])]}
    elif action == "generate_bill":
        result = generate_bill(payload)
    else:
        raise ValueError(f"Unknown bridge action: {action}")
    json.dump({"ok": True, "result": result}, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        json.dump({"ok": False, "error": str(exc)}, sys.stdout)
        sys.exit(1)
