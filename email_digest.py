"""
Daily email digest.

Reads the freshly-written web/data/items.json, filters to OPEN auction lots
that clear the thresholds in config.py (EMAIL_* settings), takes the top N by
flip_score, renders a nice HTML email, and sends it via SMTP.

If NOTHING clears the bar, no email is sent (and we exit 0 — that's a normal
"quiet day", not an error).

Run locally:
    python email_digest.py            # send for real (needs SMTP secrets)
    python email_digest.py --dry-run  # build + print the HTML, send nothing
    python email_digest.py --dry-run --save digest.html   # also write to a file

In CI a separate workflow (.github/workflows/email.yml) runs this once a day.

Secrets it needs (env vars, NOT hardcoded):
    SMTP_HOST       e.g. smtp.gmail.com           (default below)
    SMTP_PORT       e.g. 587                       (default below)
    SMTP_USERNAME   the sending Gmail address
    SMTP_PASSWORD   a Gmail "App Password" (NOT your normal password)
    EMAIL_TO        where to send the digest (defaults to SMTP_USERNAME)
    EMAIL_FROM      optional display From (defaults to SMTP_USERNAME)

How to make a Gmail App Password:
    1. Turn on 2-Step Verification at https://myaccount.google.com/security
    2. Go to https://myaccount.google.com/apppasswords
    3. Create a password named "daily-snapshot", copy the 16-char value
    4. Use that value as SMTP_PASSWORD (your normal Gmail password won't work)
"""
from __future__ import annotations

import argparse
import json
import os
import smtplib
import ssl
import sys
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from html import escape
from pathlib import Path

import config

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

SCRIPT_DIR = Path(__file__).parent.resolve()
JSON_PATH = SCRIPT_DIR / "web" / "data" / "items.json"

# Tier orderings, best -> worst. An item passes a "at least X" gate if its
# tier index is <= the index of the configured floor.
CONDITION_ORDER = ["new", "open_box", "damaged_easy_fix", "damaged_hard_fix"]
VELOCITY_ORDER = ["hot", "normal", "slow", "very_slow", "unknown"]


# ────────────────────────────── helpers ─────────────────────────────────────

def _num(x) -> float | None:
    """Parse a stringy number, return None if not parseable."""
    try:
        return float(x)
    except (ValueError, TypeError):
        return None


def _is_closed(iso_str: str) -> bool:
    """True if an ISO-UTC closing time is in the past. Unparseable -> not closed
    (we'd rather show a maybe-open item than silently drop a real one)."""
    if not iso_str:
        return False
    try:
        close = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return False
    return close <= datetime.now(timezone.utc)


def _tier_passes(value: str, floor: str, order: list[str]) -> bool:
    """True if `value` is at least as good as `floor` in the given ordering.

    Best tiers are at the front of `order` (index 0). An unknown/empty value
    fails any gate that has a real floor, EXCEPT when the floor itself is the
    worst tier (then everything passes)."""
    v = (value or "").strip().lower()
    f = (floor or "").strip().lower()
    if f not in order:
        return True  # misconfigured floor -> don't filter on it
    if v not in order:
        return False  # unknown/blank value can't be proven to clear the bar
    return order.index(v) <= order.index(f)


def select_top_items(items: list[dict]) -> list[dict]:
    """Filter to OPEN items clearing every configured threshold, sort by
    flip_score desc, return the top EMAIL_TOP_N."""
    matches = []
    for it in items:
        if _is_closed(it.get("closing_time_iso", "")):
            continue
        conf = (it.get("ai_confidence") or "").strip().lower()
        if conf in ("", "unknown"):
            continue

        fs = _num(it.get("flip_score"))
        gp = _num(it.get("gross_profit"))
        if fs is None or gp is None:
            continue

        if fs < config.EMAIL_MIN_FLIP_SCORE:
            continue
        if gp < config.EMAIL_MIN_PROFIT:
            continue
        if not _tier_passes(it.get("ai_condition", ""),
                            config.EMAIL_MIN_CONDITION, CONDITION_ORDER):
            continue
        if not _tier_passes(it.get("ai_sales_velocity", ""),
                            config.EMAIL_MIN_VELOCITY, VELOCITY_ORDER):
            continue
        matches.append(it)

    matches.sort(key=lambda it: -(_num(it.get("flip_score")) or 0))
    return matches[:config.EMAIL_TOP_N]


# ────────────────────────────── HTML render ─────────────────────────────────

# ── Palette + fonts lifted straight from web/style.css so the email reads as
# ── the same product as the dashboard. Email clients can't use <style>/CSS
# ── variables reliably, so every value is inlined below, but they're the same
# ── tokens: --accent #1f4d3f, --info #1f4477, --warn #b3791a, --bad #a4322a,
# ── --ink #1a1a1a, --rule #e3e0d8, --bg #f6f5f1, surface #fff.
_FONT_SANS = ("-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,"
              "'Helvetica Neue',Arial,sans-serif")
_FONT_MONO = ("ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,"
              "'Liberation Mono',monospace")

# Condition badge labels + colors — mirrors CONDITION_LABELS in app.js and the
# .badge--condition[data-condition=...] rules in style.css.
_COND = {
    "new":              ("new",      "#1f4d3f", "#e6efe9", "#cfe0d6", False),
    "open_box":         ("open box", "#5a5a5a", "#ffffff", "#e3e0d8", False),
    "damaged_easy_fix": ("easy fix", "#b3791a", "#f5ecd6", "#ead8b0", False),
    "damaged_hard_fix": ("hard fix", "#a4322a", "#f4d9d6", "#ecbeb9", True),
}
# Velocity badge labels + colors — mirrors .badge--velocity[data-velocity=...].
_VEL = {
    "hot":       ("hot",       "#a4322a", "#fbe9e3", "#f0c8b8", False),
    "normal":    ("normal",    "#7a5a17", "#f3eedd", "#ddd2a8", False),
    "slow":      ("slow",      "#5a5a5a", "#ece9e2", "#e3e0d8", False),
    "very_slow": ("very slow", "#8a8a8a", "#ece9e2", "#e3e0d8", True),
    "unknown":   ("unknown",   "#8a8a8a", "#ece9e2", "#e3e0d8", False),
}


def _fmt_money(x, decimals_under: float = 100) -> str:
    n = _num(x)
    if n is None:
        return "\u2014"
    return f"${n:,.0f}" if abs(n) >= decimals_under else f"${n:,.2f}"


def _fmt_roi(flip_score) -> str:
    """ROI multiple the way the dashboard shows it, e.g. '72.08\u00d7'."""
    n = _num(flip_score)
    if n is None:
        return "\u2014"
    return f"{n:.2f}\u00d7"


def _local_close_label(iso_str: str) -> str:
    """Human 'closes' string in Central time, e.g. 'Closes Sat 7:27 PM CDT'."""
    if not iso_str:
        return ""
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return ""
    try:
        from zoneinfo import ZoneInfo
        dt = dt.astimezone(ZoneInfo("America/Chicago"))
        tz = dt.tzname()
    except Exception:
        tz = "CT"
    return dt.strftime(f"Closes %a {dt.strftime('%I').lstrip('0')}:%M %p {tz}")


def _badge(label: str, ink: str, bg: str, border: str, strike: bool) -> str:
    """An email-safe pill matching the dashboard's .badge styling."""
    deco = "text-decoration:line-through;" if strike else ""
    return (f'<span style="display:inline-block;font:600 12px/1 {_FONT_SANS};'
            f'color:{ink};background:{bg};border:1px solid {border};'
            f'border-radius:4px;padding:3px 9px;margin:0 6px 0 0;{deco}">'
            f'{escape(label)}</span>')


def _stat(label: str, value: str, value_color: str = "#1a1a1a") -> str:
    """One dt/dd-style stat cell, monospace value like the dashboard."""
    return (
        f'<td valign="top" style="padding:0 10px 0 0;">'
        f'<div style="font:400 11px/1.3 {_FONT_SANS};color:#8a8a8a;'
        f'text-transform:uppercase;letter-spacing:.03em;padding-bottom:2px;">{escape(label)}</div>'
        f'<div style="font:400 14px/1.3 {_FONT_MONO};color:{value_color};'
        f'white-space:nowrap;">{value}</div></td>'
    )


def _item_card_html(it: dict, rank: int) -> str:
    """One item as an email-safe card, styled like a dashboard card but with
    ROI + gross profit pulled out as large bold hero numbers."""
    title = escape(it.get("title", "") or "(untitled)")
    img = escape(it.get("image_url", "") or "")
    url = escape(it.get("item_url", "") or "#")
    loc = escape(it.get("location", "") or "")
    cat = escape(it.get("category", "") or "")
    notes = (it.get("ai_notes", "") or "").strip()
    if len(notes) > 200:
        notes = notes[:197].rstrip() + "\u2026"
    notes = escape(notes)

    roi = _fmt_roi(it.get("flip_score"))
    profit = _fmt_money(it.get("gross_profit"))
    bid = escape(it.get("current_bid", "") or it.get("next_required_bid", "") or "\u2014")
    resale = _fmt_money(it.get("ai_estimated_resale"), decimals_under=0)
    retail = _fmt_money(it.get("ai_retail_estimate"), decimals_under=0)
    close = escape(_local_close_label(it.get("closing_time_iso", "")))

    vel = (it.get("ai_sales_velocity", "") or "").strip().lower()
    cond = (it.get("ai_condition", "") or "").strip().lower()
    badges = ""
    if vel in _VEL and vel != "unknown":
        badges += _badge(*_VEL[vel])
    if cond in _COND:
        badges += _badge(*_COND[cond])

    img_cell = (
        f'<a href="{url}" style="text-decoration:none;display:block;">'
        f'<img src="{img}" width="170" alt="" '
        f'style="display:block;width:170px;height:128px;object-fit:cover;'
        f'background:#ece9e2;border:0;"></a>'
        if img else
        '<div style="width:170px;height:128px;background:#ece9e2;'
        'border-right:1px solid #e3e0d8;"></div>'
    )

    notes_row = (
        f'<tr><td colspan="2" style="font:400 12px/1.5 {_FONT_SANS};'
        f'color:#8a8a8a;padding:10px 0 0 0;">{notes}</td></tr>'
        if notes else ''
    )
    cat_bit = f' &nbsp;&middot;&nbsp; {cat}' if cat else ''

    # ── Hero ROI + profit block. These are the two numbers the user cares
    # ── about most, so they're large, bold, and color-coded to match the
    # ── dashboard's score (green) and profit (blue) badges.
    hero = f"""
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="top" style="padding:0 22px 0 0;">
                    <div style="font:700 11px/1 {_FONT_SANS};color:#1f4d3f;letter-spacing:.06em;text-transform:uppercase;padding-bottom:4px;">ROI</div>
                    <div style="font:800 30px/1 {_FONT_MONO};color:#1f4d3f;">{roi}</div>
                  </td>
                  <td valign="top" style="padding:0;border-left:1px solid #e3e0d8;padding-left:22px;">
                    <div style="font:700 11px/1 {_FONT_SANS};color:#1f4477;letter-spacing:.06em;text-transform:uppercase;padding-bottom:4px;">Gross profit</div>
                    <div style="font:800 30px/1 {_FONT_MONO};color:#1f4477;">{profit}</div>
                  </td>
                </tr>
              </table>"""

    return f"""
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
           style="border-collapse:separate;background:#ffffff;border:1px solid #e3e0d8;
                  border-radius:8px;margin:0 0 16px 0;overflow:hidden;
                  box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 12px rgba(0,0,0,0.04);">
      <tr>
        <td width="170" valign="top" style="padding:0;">{img_cell}</td>
        <td valign="top" style="padding:14px 16px 16px;">
          <div style="font:600 11px/1 {_FONT_SANS};color:#8a8a8a;letter-spacing:.04em;text-transform:uppercase;padding-bottom:8px;">
            #{rank} best flip today
          </div>
          {hero}
          <div style="font:500 15px/1.35 {_FONT_SANS};color:#1a1a1a;padding:14px 0 10px;">
            <a href="{url}" style="color:#1a1a1a;text-decoration:none;">{title}</a>
          </div>
          <div style="padding-bottom:12px;">{badges}</div>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
                 style="border-top:1px solid #e3e0d8;padding-top:10px;">
            <tr>
              {_stat("Current bid", bid)}
              {_stat("Est. resale", resale, "#1f4d3f")}
              {_stat("Retail (new)", retail)}
            </tr>
            {notes_row}
          </table>
          <div style="font:400 12px/1.4 {_FONT_SANS};color:#8a8a8a;padding:12px 0 14px;">
            {('📍 ' + loc) if loc else ''}{cat_bit}{(' &nbsp;&middot;&nbsp; ' + close) if close else ''}
          </div>
          <a href="{url}" style="display:inline-block;font:600 13px/1 {_FONT_SANS};
                    color:#ffffff;background:#1f4d3f;text-decoration:none;
                    border-radius:6px;padding:11px 18px;">View lot on Equip-Bid &nbsp;&rarr;</a>
        </td>
      </tr>
    </table>"""


def render_html(items: list[dict]) -> str:
    """Full HTML email body for the given (already top-N) items."""
    today = datetime.now().strftime("%A, %B %-d") if sys.platform != "win32" \
        else datetime.now().strftime("%A, %B %d")

    cond_lbl = _COND.get(config.EMAIL_MIN_CONDITION, (config.EMAIL_MIN_CONDITION,))[0]
    vel_lbl = _VEL.get(config.EMAIL_MIN_VELOCITY, (config.EMAIL_MIN_VELOCITY,))[0]
    crit_bits = [
        f"{config.EMAIL_MIN_FLIP_SCORE:.0f}\u00d7+ ROI",
        f"${config.EMAIL_MIN_PROFIT:.0f}+ profit",
        f"{cond_lbl} or better",
        f"{vel_lbl} or faster",
    ]
    criteria = " &middot; ".join(escape(b) for b in crit_bits)

    cards = "\n".join(_item_card_html(it, i + 1) for i, it in enumerate(items))

    return f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Daily flips</title></head>
<body style="margin:0;padding:0;background:#f6f5f1;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f6f5f1;">
    <tr><td align="center" style="padding:24px 14px 32px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;">
        <tr><td style="padding:0 2px 18px 2px;border-bottom:1px solid #e3e0d8;margin-bottom:18px;">
          <div style="font:600 20px/1.2 {_FONT_SANS};color:#1a1a1a;letter-spacing:-0.01em;">Daily Snapshot &mdash; top {len(items)} {'flip' if len(items)==1 else 'flips'}</div>
          <div style="font:400 13px/1.5 {_FONT_SANS};color:#5a5a5a;padding-top:6px;">{escape(today)} &nbsp;&middot;&nbsp; matching {criteria}</div>
        </td></tr>
        <tr><td style="padding-top:18px;">{cards}</td></tr>
        <tr><td style="padding:6px 2px 0 2px;font:400 12px/1.5 {_FONT_SANS};color:#8a8a8a;">
          Estimates are AI-generated and approximate. Bids climb through the day &mdash; verify the current price on the lot page before bidding.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""


def render_text(items: list[dict]) -> str:
    """Plain-text fallback (some clients prefer/only show this)."""
    lines = [f"Daily Snapshot - top {len(items)} flips", ""]
    for i, it in enumerate(items, 1):
        lines.append(f"{i}. {it.get('title','Untitled')}")
        lines.append(f"   ROI {_fmt_roi(it.get('flip_score'))}  |  "
                     f"gross profit {_fmt_money(it.get('gross_profit'))}")
        lines.append(f"   bid {it.get('current_bid') or it.get('next_required_bid','?')} -> "
                     f"resale {_fmt_money(it.get('ai_estimated_resale'), 0)}")
        if it.get("location"):
            lines.append(f"   {it['location']}")
        lines.append(f"   {it.get('item_url','')}")
        lines.append("")
    return "\n".join(lines)


# ────────────────────────────── send ────────────────────────────────────────

def send_email(html: str, text: str, subject: str) -> None:
    host = os.getenv("SMTP_HOST", config.EMAIL_SMTP_HOST)
    port = int(os.getenv("SMTP_PORT", str(config.EMAIL_SMTP_PORT)))
    user = os.getenv("SMTP_USERNAME", "")
    password = os.getenv("SMTP_PASSWORD", "")
    to_addr = os.getenv("EMAIL_TO", "") or user
    from_addr = os.getenv("EMAIL_FROM", "") or user

    missing = [n for n, v in [("SMTP_USERNAME", user),
                              ("SMTP_PASSWORD", password),
                              ("EMAIL_TO", to_addr)] if not v]
    if missing:
        raise SystemExit(
            "Cannot send email \u2014 missing env var(s): " + ", ".join(missing)
            + "\nSet them locally in a .env file or in CI as repo secrets."
        )

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg.attach(MIMEText(text, "plain", "utf-8"))
    msg.attach(MIMEText(html, "html", "utf-8"))

    ctx = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=ctx, timeout=60) as s:
            s.login(user, password)
            s.sendmail(from_addr, [a.strip() for a in to_addr.split(",")], msg.as_string())
    else:
        with smtplib.SMTP(host, port, timeout=60) as s:
            s.ehlo()
            s.starttls(context=ctx)
            s.ehlo()
            s.login(user, password)
            s.sendmail(from_addr, [a.strip() for a in to_addr.split(",")], msg.as_string())
    print(f"Sent digest to {to_addr} ({len(html)} bytes of HTML).")


# ────────────────────────────── main ────────────────────────────────────────

def load_items() -> list[dict]:
    if not JSON_PATH.exists():
        raise SystemExit(f"No data file at {JSON_PATH}. Run scrape.py first.")
    with JSON_PATH.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("items", [])


def main() -> int:
    ap = argparse.ArgumentParser(description="Send the daily flip-digest email.")
    ap.add_argument("--dry-run", action="store_true",
                    help="build the email but don't send it")
    ap.add_argument("--save", metavar="PATH",
                    help="write the rendered HTML to this file (useful with --dry-run)")
    args = ap.parse_args()

    all_items = load_items()
    picks = select_top_items(all_items)

    print(f"Scanned {len(all_items)} items; {len(picks)} cleared the thresholds "
          f"(flip>={config.EMAIL_MIN_FLIP_SCORE}, profit>=${config.EMAIL_MIN_PROFIT}, "
          f"cond>={config.EMAIL_MIN_CONDITION}, vel>={config.EMAIL_MIN_VELOCITY}).")

    if not picks:
        print("Nothing cleared the bar today \u2014 no email sent. (This is normal.)")
        return 0

    html = render_html(picks)
    text = render_text(picks)
    n = len(picks)
    subject = config.EMAIL_SUBJECT.format(
        n=n,
        plural="" if n == 1 else "s",
        date=datetime.now().strftime("%b %d"),
    )

    if args.save:
        Path(args.save).write_text(html, encoding="utf-8")
        print(f"Wrote HTML to {args.save}")

    if args.dry_run:
        print(f"\n--- DRY RUN (no email sent) ---\nSubject: {subject}")
        for i, it in enumerate(picks, 1):
            print(f"  {i}. [{_fmt_roi(it.get('flip_score'))} / "
                  f"{_fmt_money(it.get('gross_profit'))}] {it.get('title','')[:60]}")
        return 0

    send_email(html, text, subject)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
