from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, PageBreak,
    Table, TableStyle, KeepTogether, HRFlowable, Flowable
)
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase import pdfmetrics
from xml.sax.saxutils import escape
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "output" / "pdf" / "OmniLume_Master_Product_Roadmap_Implementation_Blueprint.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)

INK = colors.HexColor("#0F172A")
SLATE = colors.HexColor("#334155")
MUTED = colors.HexColor("#64748B")
LINE = colors.HexColor("#CBD5E1")
PAPER = colors.HexColor("#F8FAFC")
VIOLET = colors.HexColor("#6D28D9")
CYAN = colors.HexColor("#0E7490")
GREEN = colors.HexColor("#15803D")
AMBER = colors.HexColor("#B45309")
RED = colors.HexColor("#B91C1C")
BLUE = colors.HexColor("#1D4ED8")
WHITE = colors.white

try:
    pdfmetrics.registerFont(TTFont("DejaVu", "C:/Windows/Fonts/arial.ttf"))
    pdfmetrics.registerFont(TTFont("DejaVu-Bold", "C:/Windows/Fonts/arialbd.ttf"))
    BODY_FONT = "DejaVu"
    BOLD_FONT = "DejaVu-Bold"
except Exception:
    BODY_FONT = "Helvetica"
    BOLD_FONT = "Helvetica-Bold"


styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="CoverKicker", fontName=BOLD_FONT, fontSize=10, leading=13, textColor=colors.HexColor("#A5B4FC"), spaceAfter=12, tracking=1.3))
styles.add(ParagraphStyle(name="CoverTitle", fontName=BOLD_FONT, fontSize=31, leading=35, textColor=WHITE, spaceAfter=12))
styles.add(ParagraphStyle(name="CoverSub", fontName=BODY_FONT, fontSize=14, leading=20, textColor=colors.HexColor("#E2E8F0"), spaceAfter=22))
styles.add(ParagraphStyle(name="CoverMeta", fontName=BODY_FONT, fontSize=9, leading=13, textColor=colors.HexColor("#CBD5E1")))
styles.add(ParagraphStyle(name="H1x", fontName=BOLD_FONT, fontSize=19, leading=23, textColor=INK, spaceBefore=5, spaceAfter=9, keepWithNext=True))
styles.add(ParagraphStyle(name="H2x", fontName=BOLD_FONT, fontSize=13, leading=17, textColor=VIOLET, spaceBefore=10, spaceAfter=5, keepWithNext=True))
styles.add(ParagraphStyle(name="H3x", fontName=BOLD_FONT, fontSize=10.2, leading=13, textColor=SLATE, spaceBefore=7, spaceAfter=3, keepWithNext=True))
styles.add(ParagraphStyle(name="Bodyx", fontName=BODY_FONT, fontSize=8.8, leading=12.4, textColor=SLATE, spaceAfter=5))
styles.add(ParagraphStyle(name="Smallx", fontName=BODY_FONT, fontSize=7.4, leading=9.5, textColor=SLATE, spaceAfter=3))
styles.add(ParagraphStyle(name="Tinyx", fontName=BODY_FONT, fontSize=6.5, leading=8.2, textColor=SLATE))
styles.add(ParagraphStyle(name="Bulletx", fontName=BODY_FONT, fontSize=8.5, leading=11.5, leftIndent=10, firstLineIndent=-7, textColor=SLATE, spaceAfter=2))
styles.add(ParagraphStyle(name="Calloutx", fontName=BODY_FONT, fontSize=8.8, leading=12.4, textColor=INK, spaceAfter=0))
styles.add(ParagraphStyle(name="TableHead", fontName=BOLD_FONT, fontSize=7.2, leading=8.6, textColor=WHITE))
styles.add(ParagraphStyle(name="TableCell", fontName=BODY_FONT, fontSize=6.8, leading=8.2, textColor=SLATE))
styles.add(ParagraphStyle(name="TableCellBold", fontName=BOLD_FONT, fontSize=6.8, leading=8.2, textColor=INK))
styles.add(ParagraphStyle(name="CenterSmall", fontName=BOLD_FONT, fontSize=7.4, leading=9, textColor=WHITE, alignment=TA_CENTER))
styles.add(ParagraphStyle(name="RightSmall", fontName=BODY_FONT, fontSize=7.2, leading=9, textColor=MUTED, alignment=TA_RIGHT))


def P(text, style="Bodyx"):
    text = str(text).replace("\u2019", "'")
    return Paragraph(escape(text).replace("\n", "<br/>") , styles[style])


def rich(text, style="Bodyx"):
    return Paragraph(text, styles[style])


def bullets(items, style="Bulletx"):
    return [P("- " + item, style) for item in items]


def badge(text, color):
    return Table([[P(text.upper(), "CenterSmall")]], colWidths=[max(42, len(text) * 4.7 + 13)], style=TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), color),
        ("BOX", (0, 0), (-1, -1), 0, color),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))


STATUS = {"DONE": GREEN, "PARTIAL": AMBER, "BROKEN": RED, "MISSING": MUTED, "BLOCKED": RED, "UNVERIFIED": AMBER, "MOCKED": MUTED, "P0": RED, "P1": AMBER, "P2": BLUE, "P3": MUTED}


def callout(label, text, color=colors.HexColor("#FEF3C7"), edge=AMBER):
    t = Table([[badge(label, edge), P(text, "Calloutx")]], colWidths=[78, 422], hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), color),
        ("BOX", (0, 0), (-1, -1), 0.7, edge),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return t


def section(title, subtitle=None):
    out = [P(title, "H1x")]
    if subtitle:
        out.append(P(subtitle, "Bodyx"))
    out.append(HRFlowable(width="100%", thickness=0.6, color=LINE, spaceBefore=0, spaceAfter=8))
    return out


def sub(title, text=None):
    out = [P(title, "H2x")]
    if text:
        out.append(P(text, "Bodyx"))
    return out


def table(headers, rows, widths, font=6.8, repeat=True):
    data = [[P(h, "TableHead") for h in headers]]
    for row in rows:
        data.append([P(c, "TableCell") if not hasattr(c, "wrap") else c for c in row])
    t = Table(data, colWidths=widths, repeatRows=1 if repeat else 0, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("GRID", (0, 0), (-1, -1), 0.35, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PAPER]),
    ]))
    return t


class RoadmapDocTemplate(BaseDocTemplate):
    def __init__(self, filename, **kwargs):
        super().__init__(filename, **kwargs)
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="normal")
        self.addPageTemplates([PageTemplate(id="main", frames=frame, onPage=self.draw_page)])

    def draw_page(self, canvas, doc):
        page = canvas.getPageNumber()
        w, h = A4
        if page == 1:
            canvas.saveState()
            canvas.setFillColor(INK)
            canvas.rect(0, 0, w, h, fill=1, stroke=0)
            canvas.setFillColor(VIOLET)
            canvas.circle(w - 40 * mm, h - 34 * mm, 30 * mm, fill=1, stroke=0)
            canvas.setFillColor(CYAN)
            canvas.circle(18 * mm, 24 * mm, 20 * mm, fill=1, stroke=0)
            canvas.restoreState()
            return
        canvas.saveState()
        canvas.setStrokeColor(LINE)
        canvas.setLineWidth(0.4)
        canvas.line(doc.leftMargin, h - 17 * mm, w - doc.rightMargin, h - 17 * mm)
        canvas.setFont(BOLD_FONT, 7.5)
        canvas.setFillColor(MUTED)
        canvas.drawString(doc.leftMargin, h - 13 * mm, "OMNILUME / MASTER PRODUCT ROADMAP")
        canvas.setFont(BODY_FONT, 7.5)
        canvas.drawRightString(w - doc.rightMargin, h - 13 * mm, "03 September 2026")
        canvas.line(doc.leftMargin, 14 * mm, w - doc.rightMargin, 14 * mm)
        canvas.setFont(BODY_FONT, 7)
        canvas.setFillColor(MUTED)
        canvas.drawString(doc.leftMargin, 9 * mm, "Confidential working blueprint | Source of truth: current repository and recorded project history")
        canvas.drawRightString(w - doc.rightMargin, 9 * mm, "Page %d" % page)
        canvas.restoreState()


def action(num, title, priority, status, depends, unlocks, why_now, why_earlier, why_later,
           current, existing, missing, implementation, reuse, new_code, db, realtime, ui,
           security, risks, regression, rollback, tests=None, done=None):
    if done is None:
        done = tests
        tests = ["Run the relevant static, database, authenticated, browser, and production checks for this scope."]
    elems = []
    elems += section("ACTION %02d - %s" % (num, title), "Priority: %s | Status: %s | Depends on: %s | Unlocks: %s" % (priority, status, depends, unlocks))
    elems.append(Table([[badge(priority, STATUS.get(priority, BLUE)), badge(status, STATUS.get(status, MUTED))]], colWidths=[70, 85], style=TableStyle([("VALIGN", (0,0), (-1,-1), "MIDDLE"), ("LEFTPADDING", (0,0), (-1,-1), 0), ("RIGHTPADDING", (0,0), (-1,-1), 5), ("TOPPADDING", (0,0), (-1,-1), 0), ("BOTTOMPADDING", (0,0), (-1,-1), 4)])))
    elems += sub("Why now?", why_now)
    elems += sub("Why not earlier?", why_earlier)
    elems += sub("Why not later?", why_later)
    elems += sub("Current state", current)
    elems += sub("What is already implemented?", existing)
    elems += sub("What is missing?", missing)
    elems += sub("How will we implement it?", None)
    elems += bullets(implementation)
    elems += sub("Existing code we will reuse", reuse)
    elems += sub("New code we need", new_code)
    elems += sub("Database changes", db)
    elems += sub("Realtime changes", realtime)
    elems += sub("UI changes", ui)
    elems += sub("Security considerations", security)
    elems += sub("What could break?", risks)
    elems += sub("How will we prevent regressions?", regression)
    elems += sub("Rollback plan", rollback)
    elems += sub("How will we test it?", None)
    elems += bullets(tests)
    elems += sub("Definition of Done", None)
    elems += bullets(done)
    return elems


story = []

# Cover
story += [Spacer(1, 35 * mm), P("OMNILUME", "CoverKicker"), P("MASTER PRODUCT ROADMAP & IMPLEMENTATION BLUEPRINT", "CoverTitle"), P("A dependency-aware plan for evolving the current collaborative room product into a secure, social, multi-purpose platform.", "CoverSub"), Spacer(1, 38 * mm), P("Prepared from the current repository, master plan, remediation history, production verification history, and the product requirements recorded in this conversation.", "CoverMeta"), Spacer(1, 5 * mm), P("Document purpose: decide what OmniLume is, where it stands, what must be fixed, what should be built next, and what evidence is required before launch.", "CoverMeta"), PageBreak()]

# Executive overview
story += section("EXECUTIVE SUMMARY", "The short version for product, engineering, security, and release decisions.")
story.append(callout("READINESS", "Production-ready core remediation is not the same as a production-ready complete product. OmniLume has a strong remediated room foundation, but the full vision still requires identity onboarding, social relationships, Personal/General chat, group conversion decisions, music integrations, broader runtime proof, and final schema/documentation alignment.", colors.HexColor("#FEE2E2"), RED))
story += sub("What OmniLume is")
story += [P("OmniLume is a collaborative digital-space platform. Rooms are temporary or permanent spaces where people watch, chat, study, share files, and coordinate activity together. Personal Chat is a separate social communication system containing friend conversations, General conversations, and persistent groups created through explicit room conversion.", "Bodyx")]
story += sub("Where we are now")
story += bullets([
    "Core room architecture exists: authentication, room creation/joining, membership, roles, room chat, Watch, Files, Study, Focus Lock, presence, expiry, recovery, and shared realtime primitives.",
    "Security remediation is substantially present: ordered RLS work, storage scoping, message ownership protection, recovery/permanent-room functions, and cleanup protections were implemented and earlier live probes were reported as passing.",
    "The public homepage no longer exposes create/join controls. Unauthenticated direct create/join paths are protected by the proxy and server checks.",
    "E2EE private chat has per-message decryption tolerance and an undecryptable-message state. Private keys remain device-side in the current design.",
    "The latest known repository baseline is branch feature/chore/track-supabase-metadata at 2e1a8f6, with origin/main also at that commit in the last recorded state. This PDF does not change or commit the repository.",
])
story += sub("What is not yet proven or not yet built")
story += bullets([
    "Fresh private-room creation and isolation should be revalidated after the earlier authenticated 403 report; do not treat old evidence as a substitute for a clean current test.",
    "Independent two-user Watch/seek, presence, recovery UI, notification delivery, actual Vercel Cron execution, true SSR refresh, and mixed E2EE runtime behavior remain incomplete or unverified in the recorded history.",
    "Google-only OAuth onboarding, profile completion, public/private social graph, Personal/General chat, robust persistent groups, and music provider integrations are product work still to build.",
    "The current local migration set includes 002, 003, 004, and 005. The live alignment of 005 and the canonical base schema/documentation should be checked before the next release.",
])
story += sub("How to read this blueprint")
story += [P("A status such as Implemented in source means code exists. Static verification means checks such as TypeScript/build/lint passed. Local runtime verified means the feature was used locally. Multi-user verified means independent sessions were observed together. Database/security verified means direct authorization behavior was tested. Production verified means the deployed environment was observed. These are different evidence levels.", "Bodyx")]
story += [PageBreak()]

# status + inventory
story += section("STATUS LEGEND AND CURRENT INVENTORY")
legend_rows = [
    ["DONE", "The defined scope is implemented and evidence exists at the stated level."],
    ["PARTIAL", "A meaningful portion exists, but required behavior or proof remains."],
    ["BROKEN", "The current behavior fails an important expected path."],
    ["MISSING", "The product requirement has not been implemented."],
    ["BLOCKED", "Progress is stopped by a known dependency, environment, or product decision."],
    ["UNVERIFIED", "The code may exist, but the required runtime or remote evidence is missing."],
    ["MOCKED", "The interface or placeholder exists without the complete underlying behavior."],
]
story.append(table(["Status", "Meaning"], legend_rows, [92, 408]))
story += sub("Current implementation map")
inventory = [
    ["Public landing", "DONE / production smoke evidence", "src/app/page.tsx, Navbar, NavLinks", "Keep authenticated create/join in Explore and create-room; do not restore public controls."],
    ["Authentication", "PARTIAL / source + smoke", "src/app/login/page.tsx, src/proxy.ts, Supabase helpers", "Google OAuth and profile-completion routing remain to be designed/configured."],
    ["Rooms", "PARTIAL / core works, fresh isolation recheck", "src/actions/rooms.ts, room routes, room_members", "Complete permission surface, leave behavior, and fresh private-room test."],
    ["Room realtime", "DONE in source / runtime breadth unverified", "RoomRealtimeProvider, useRoomSync, useRoomPresence", "Independent watch, presence, reconnect, late-join evidence."],
    ["Room chat", "DONE core / runtime proof mixed", "RoomChat, chat actions, messages", "Verify both directions, delete propagation, attachments and feature flags."],
    ["Private E2EE chat", "DONE in source / mixed runtime unverified", "usePrivateChat, encryption, PrivateChat", "Test key loss/rotation behavior without exposing sensitive material."],
    ["Security migrations", "SUBSTANTIALLY REMEDIATED / verify current remote", "002, 003, 004, 005, POLICIES.md", "Reconfirm live migration state and canonical schema drift."],
    ["Recovery/lifecycle", "PARTIAL / direct tests reported, browser proof open", "recovery.ts, room-lifecycle.ts, cleanup route", "Verify 24-hour request window, 7-day reopen, permanent conversion and notifications."],
    ["Social identity", "MISSING", "profiles exists; social graph not complete", "Google onboarding, profile privacy, followers, friends."],
    ["Personal/General chat", "MISSING / current private chat is not the full model", "messages page and existing private chat", "Relationship-gated conversations and persistent groups."],
    ["Music", "MISSING as complete product", "No complete provider/storage system recorded", "Personal uploads, provider OAuth, player, room/group sync."],
    ["Calls/AI/scheduling", "MISSING or future", "Master plan concepts", "Build only after core identity, permissions, realtime, and privacy foundations."],
]
story.append(table(["System", "Status", "Evidence / current code", "Remaining work"], inventory, [82, 105, 145, 168]))
story += [PageBreak()]

# Critical blockers
story += section("CRITICAL ISSUES AND RELEASE BLOCKERS", "These are the issues that should be resolved or explicitly accepted before expanding the product surface.")
blockers = [
    ["P0", "Live security truth", "Repository migrations and live objects must agree. The recorded history says 002/003/004 were aligned, while 005 is locally present and should be rechecked.", "Verify migration list plus live policies/functions/triggers. Never use UI success as security proof.", "Security release gate remains open until current remote evidence is recorded."],
    ["P0", "Fresh private-room creation / isolation", "An authenticated create-room request previously returned 403, blocking a fresh private-room matrix.", "Reproduce with disposable accounts; trace action, proxy/session, RPC/policy; fix only if real; rerun creator/member/non-member/anonymous/expired cases.", "High: false failures may hide a security or availability defect."],
    ["P0", "Independent multi-user runtime proof", "Several critical flows were source-reviewed or tested in shared browser contexts, not fully observed with isolated storage.", "Use separate persistent profiles or separate browser applications and record identity independence before collaboration tests.", "Core collaboration cannot be called production verified without it."],
    ["P1", "Recovery and permanent-room semantics", "The final product model requires expiry -> 24-hour request window -> approval -> exactly 7-day reopen -> permanent conversion request/approval.", "Lock schema and state transitions before building more UI; verify owner/admin/member authorization and notification scope.", "Lifecycle ambiguity can cause data loss or false promises."],
    ["P1", "Canonical schema drift", "Base schema contains older policy definitions while POLICIES.md describes ordered effective state.", "Update canonical documentation/schema only after comparing live and migration state; avoid destructive replacement.", "Future developers could recreate insecure policy state."],
    ["P1", "Product decisions before social/music build", "Google-only onboarding, group feature surface, profile fields, and provider playback limitations are not all settled in one consistent contract.", "Adopt a decision record before migrations and UI are created.", "Building first can force breaking schema or privacy changes later."],
]
story.append(table(["Priority", "Issue", "Problem / why it matters", "Required evidence or action", "Release impact"], blockers, [45, 105, 145, 140, 65]))
story += sub("Current-to-target snapshot")
snapshot = [
    ["Identity", "Supabase auth and profiles exist; Google onboarding incomplete", "Google OAuth, profile completion gate, privacy-safe public profile"],
    ["Rooms", "Core create/join/roles/activities exist; some runtime breadth open", "Reliable rooms with tested membership, permissions, lifecycle, and responsive layout"],
    ["Chat", "Room chat and E2EE private chat exist", "Separate room, Personal, General, and group conversations with clear authorization"],
    ["Realtime", "Shared room provider exists", "One authorized event architecture with reconnect, dedupe, late-join recovery"],
    ["Lifecycle", "Expiry, recovery, permanent conversion code exists", "Proven state machine, bounded recovery, 7-day reopen, indefinite permanent state"],
    ["Music", "Vision documented; full system missing", "Private personal player plus permissioned room/group music without token leakage"],
]
story.append(table(["System", "CURRENT STATE", "TARGET STATE"], snapshot, [78, 205, 217]))
story += [PageBreak()]

# Vision and architecture
story += section("PRODUCT MODEL: TWO SEPARATE WORLDS")
story += [callout("RULE", "Rooms and Personal Chat must remain separate. A room becomes a Personal group only after an explicit authorized conversion. Room membership must never silently grant access to unrelated personal conversations.", colors.HexColor("#ECFEFF"), CYAN)]
story += sub("Rooms")
story += bullets([
    "Collaborative spaces for watching, studying, files, media, presence, notifications, and room chat.",
    "Have a display name and, while they are rooms, may have a unique lowercase username/custom join link.",
    "Can be public or private, temporary or permanent, with owner/admin/member roles and server-enforced permissions.",
    "Use shared room realtime state so Chat, Watch, Files, Study, presence, and future Music coordinate through one room identity.",
])
story += sub("Personal Chat")
story += bullets([
    "A private social area with top-level Personal and General sections.",
    "Personal contains accepted friends and persistent groups. Groups appear in Groups and All; friends appear in All.",
    "General handles non-friend conversations enabled by a follow relationship or an accepted chat request.",
    "Private one-to-one messages retain the existing E2EE design; room chat and personal E2EE chat are not merged accidentally.",
])
story += sub("Room-to-group conversion decision")
story.append(callout("DECISION", "The requirements in this conversation conflict on whether a converted group retains room-style features. The latest direct product description says the group carries room data and can access its workspace features; another specification says converted groups should exclude Watch, Study, Focus Lock, room presence, and expiration. Resolve this before implementation. The safest default is to preserve data, create one permanent group, remove the public room username, and expose only explicitly approved workspace features through group permissions.", colors.HexColor("#FFF7ED"), AMBER))
story += sub("Dependency map")
dep_rows = [
    ["1. Foundation", "Current Next.js/Supabase architecture, typed actions, storage abstraction"],
    ["2. Identity", "Google OAuth, profile completion, privacy, username"],
    ["3. Authorization", "RLS, roles, relationship rules, feature permissions"],
    ["4. Room lifecycle", "Creation, joining, leave, expiry, recovery, permanent state"],
    ["5. Shared realtime", "One room/group event model, presence, reconnects, dedupe"],
    ["6. Core collaboration", "Chat, Watch, Files, Study, Notes/PDF/whiteboard"],
    ["7. Social messaging", "Followers, friends, Personal/General, groups"],
    ["8. Music", "Personal providers/uploads, room/group shared playback"],
    ["9. Advanced", "Calls, AI, scheduling, moderation, memories"],
    ["10. Hardening", "Mobile, performance, observability, tests, production release"],
]
story.append(table(["Dependency flow", "Why it is upstream"], dep_rows, [150, 350]))
story += [PageBreak()]

# Actions 1-8
story += action(1, "Secure and Stabilize the Foundation", "P0", "PARTIAL", "Current codebase", "Every later feature", "Security and behavior must be measured before more data models are added. A weak foundation makes every later feature expensive to repair.", "The existing remediation and current architecture are the starting point; a new framework or rewrite would add risk.", "Later social, music, and group features would multiply the impact of an unresolved auth/RLS or schema problem.", "Next.js 16.3.3, React 19, Supabase SSR/browser/server clients, typed server actions, current route structure, and ordered migrations exist.", "Preserve src/proxy.ts, Supabase helpers, current RLS model, RoomRealtimeProvider, room lifecycle, E2EE key handling, and existing user data.", "A verified inventory of every route, action, table, policy, storage path, realtime channel, and environment variable; current 403 cause; current remote 005 status.", ["Record a clean Git baseline and do not overwrite user changes.", "Build an architecture inventory and identify one authoritative implementation for each core behavior.", "Run typecheck, build, lint, diff checks, and safe security probes.", "Create release evidence that distinguishes source, static, live, and production verification."], "Existing actions, providers, routes, policies, tests, and reports.", "Small verification scripts and decision records, not a replacement architecture.", "No broad schema change. Reconcile base schema documentation with migrations; use additive migrations only when a confirmed gap exists.", "Document one channel per room identity and one server authorization path per sensitive mutation.", "Add a release dashboard/checklist, safe error states, and operator-facing evidence without exposing secrets.", "Never solve availability by weakening RLS. Keep service-role use limited to trusted cleanup paths.", "A broad cleanup could delete live functionality or obscure the real source of a failure.", "Use targeted diffs, route smoke tests, policy snapshots, and a rollback branch/tag for any migration.", "Git status, source inventory, tsc, build, lint, direct RLS probes, production HTTP smoke checks.", ["Remote and local state are documented.", "No critical/high security gap is unexplained.", "All new work has a rollback and verification plan."])
story.append(PageBreak())
story += action(2, "Reconcile Database Security and Canonical Schema", "P0", "PARTIAL", "Action 1", "Safe rooms, chat, storage, recovery, social data", "All product features depend on trustworthy authorization. Database RLS is the database-level rule that still applies even if someone bypasses the interface.", "The current 002/003/004 work is already the basis; redoing it risks duplicate policies and migration history damage.", "Every new table will otherwise repeat insecure assumptions and later require emergency fixes.", "002 RLS lockdown, 003 lifecycle, 004 security remediation, and local 005 room-creation policy exist; earlier reports recorded aligned 002/003/004 and passing probes.", "Preserve existing policy intent, active/reopened room checks, sender ownership, storage UUID paths, service-role cleanup boundaries, and legacy room_messages table unless proven removable.", "Reconfirm live 002-005 state; remove stale base-policy definitions from canonical documentation if they can mislead future work; resolve the earlier 403.", ["Compare live pg_policies, functions, triggers, columns, grants, and migration history with local migrations.", "Ensure rooms, room_members, messages, temporary_media, storage.objects, reactions, study, recovery, notifications, and future group tables have least-privilege policies.", "Protect immutable identity/scope fields with constraints or triggers where RLS alone is insufficient.", "Add indexes for membership, active lifecycle, unread counts, and relationship lookups only after query evidence."], "supabase/01_schema.sql, 002_rls_lockdown.sql, 003_room_lifecycle.sql, 004_security_remediation.sql, 005_restore_room_creation_policy.sql, POLICIES.md.", "Only confirmed additive columns, constraints, indexes, and policies; no table reset or bulk cleanup.", "Use migration files with explicit order. Do not replay 002/003. Do not use repair unless live objects match exactly.", "Authorize private channel events by room/group membership and feature permission; never send provider tokens or private keys.", "Use truthful denied, pending, and expired states. Avoid UI that suggests a user can access a resource the database will deny.", "Policy drift, public SELECT, self-promotion, sender-only update, incorrect storage path expression, dangerous SECURITY DEFINER, expired-room bypass.", "Direct anonymous and role-matrix probes; compare policy SQL; test server action and direct database paths independently.", "Only additive migrations can be reversed safely; policy corrections require a reviewed down-plan or forward fix, not reset.", "Anonymous probes, owner/admin/member/former/pending/rejected/unrelated matrix, storage tests, migration list, policy/function/trigger inspection.", ["No private data is anonymously readable.", "Former members cannot mutate old messages.", "Room lifecycle and recovery rules are database-backed.", "Canonical docs cannot recreate old insecure state."])
story.append(PageBreak())
story += action(3, "Finish Authentication and First-Run Identity", "P0", "MISSING", "Actions 1-2", "Profiles, social graph, safe navigation", "Every social, privacy, and personal chat rule needs a stable user identity and a clear onboarding state.", "Google OAuth configuration and profile fields depend on agreed product decisions; building them before schema/security review risks duplicate users.", "Later profile, friendship, and provider-account migrations would need to retrofit missing identity semantics.", "Supabase auth, login page, proxy/session refresh, and safe next-path redirect patterns exist. The public homepage Sign In is production smoke-tested.", "Preserve existing auth records, session cookies, proxy matcher, server/browser clients, login error/loading patterns, and direct route protection.", "Google provider setup, callback route, profile completion gate, username uniqueness, DOB/gender/visibility/bio/picture validation, update profile, logout, and safe redirect handling.", ["Configure Google OAuth in Supabase, Google Cloud, localhost, preview, and production.", "After OAuth, load the existing profile; route complete profiles to the app and incomplete profiles to setup.", "Validate required fields, age/DOB, controlled gender options, image size/type, bio length, lowercase username, and privacy default.", "Prevent duplicate profile rows and preserve a user’s intended destination after login."], "src/app/login/page.tsx, src/proxy.ts, Supabase SSR helpers, profiles table, existing Navbar/NavLinks.", "Profile setup route, callback handler if absent, validation schema, profile actions, and configuration documentation.", "Additive profile columns/constraints/indexes and RLS for public/private fields; never store OAuth secrets in app tables.", "Auth state should be refreshed through the existing SSR path; avoid new global auth channels.", "Clear setup progress, errors, missing-profile state, logout, and accessible login controls.", "OAuth redirect abuse, account duplication, public DOB/gender leakage, unsafe next paths, missing profile gate.", "Use OAuth callback tests, session refresh checks, profile RLS tests, safe redirect allowlist, and no-secret logging.", "If OAuth configuration is wrong, roll back routing changes while leaving existing accounts intact.", "Existing Google test account, incomplete/complete profile, logout/login, callback errors, production and preview redirect URLs.", ["A new Google user cannot reach the normal app without required profile setup.", "An existing complete user reaches the app.", "No private profile field leaks.", "Login/logout/session refresh remain intact."])
story.append(PageBreak())
story += action(4, "Build Profiles, Privacy, Followers, and Friends", "P1", "MISSING", "Action 3", "Relationship-gated messaging and discovery", "This is the policy layer for who can discover, follow, message, or become friends with whom.", "It relies on stable profiles, Google identity, and database authorization.", "Personal/General chat and group membership cannot be correct without explicit relationship states.", "Profiles exist, but the full public/private social model is not recorded as implemented.", "Preserve profile identity, existing E2EE public-key behavior, and privacy-safe storage; do not conflate friends with followers.", "Follower/follow-request states, friend requests and normalized friendships, profile visibility UI, accept/reject/unfollow/remove flows, and privacy-aware post/list reads.", ["Create directional follows with pending/accepted/rejected/cancelled states and unique pairs.", "Create friend requests with reverse-direction duplicate protection and a normalized friendship table.", "On friendship acceptance, safely create mutual follows without duplicates; keep relationships separate when friendship is removed.", "Apply public/private rules to profiles, posts, follower lists, following lists, and requests."], "profiles table, Supabase RLS conventions, server actions, existing notification/realtime patterns.", "Social schema, typed relationship actions, profile pages, relationship buttons, requests inbox, and RLS policies.", "Additive tables and constraints only; no automatic mass-follow migration unless explicitly approved.", "Publish authorized relationship/request events; deduplicate on reconnect.", "Buttons must show Add friend, request sent, accept, friends green tick, remove, follow/unfollow, pending states, and errors.", "Self-follow, duplicate requests, accepting another user’s request, private list leakage, friend count exposure.", "Direct RLS tests for owner/target/unrelated users and two-user browser tests with public/private combinations.", "Disable new social routes behind a feature flag or remove additive tables if rollout fails; preserve profiles and auth.", "Public/private matrix, duplicate/reverse request tests, privacy switch, request acceptance/rejection, no public friend count.", ["All states are server and database enforced.", "Friends are mutual; follows are directional.", "Private content/list visibility follows accepted follower/friend rules."])
story.append(PageBreak())
story += action(5, "Separate and Expand Personal Chat", "P1", "MISSING", "Actions 2-4, existing E2EE", "Personal, General, and group conversations", "The current private E2EE chat is valuable but it is not the complete Personal/General product model.", "Conversation access depends on relationship tables, profile identity, and an explicit data model.", "If room chat, private chat, general requests, and groups are mixed now, later conversion will create duplicate histories and privacy bugs.", "Existing private chat uses encrypted payloads, device-side keys, per-message failure tolerance, and an undecryptable state. Room chat is separate.", "Preserve E2EE protocol, message encryption, key storage boundaries, message ordering, decryption tolerance, and room chat path.", "Conversation types, General chat requests, Personal Groups/All lists, accepted-friend conversations, accepted request rules, read/unread state, blocking if supported.", ["Model room, private_friend, general, and group conversations explicitly; prevent a message from belonging to conflicting scopes.", "Keep General access to one-way follow or accepted request; block messages before required acceptance.", "When users become friends, relabel or expose the same conversation in Personal without duplicating history.", "Use per-message decryption tolerance and safe undecryptable UI for all E2EE history and realtime inserts."], "usePrivateChat, PrivateChat, chat actions, encryption helpers, messages route, current messages table where compatible.", "Conversation tables/columns, relationship-gated server actions, Personal/General UI, requests panel, unread/read state.", "Additive conversation metadata and RLS; do not migrate room messages into personal data by guesswork.", "Use existing room provider for rooms; use an authorized personal messaging subscription only after access checks.", "Clear top-level tabs, empty/error/loading states, friend vs group visual distinction, safe request feedback.", "Plaintext fallback, private-key leakage, cross-room reads, duplicate conversations, messaging before acceptance, request privacy leak.", "E2EE device tests, direct database authorization, two-user request/message tests, refresh persistence, crypto log audit.", "Hide new conversation types behind a controlled rollout; preserve existing private chat if the new list fails.", "Friend chat, General one-way follow, request accept/reject, friendship reclassification, mixed decryptability, no sensitive logs.", ["Personal shows only accepted friends/groups.", "General access is relationship/request governed.", "Existing E2EE private chat remains secure and usable."])
story.append(PageBreak())
story += action(6, "Complete Room Membership, Roles, Features, and Layout", "P1", "PARTIAL", "Actions 1-2, room core", "Reliable rooms, groups, and future shared features", "Room creation, join, leave, and permissions are the contract all collaboration features use.", "The current room/lifecycle foundations and earlier security remediation must be preserved while the known create-room 403 is understood.", "Group conversion, room music, files, and admin tools would otherwise lack a trustworthy permission surface.", "Room create/join, public/private modes, owner/admin/member roles, feature components, leave/expiry helpers, and room settings concepts exist; a fresh private-room matrix is still important.", "Preserve room URLs, usernames while room, membership approval, owner transfer rules, current activities, shared provider, expiry/recovery, and storage references.", "A real leave flow, granular admin permissions, feature flags/hide state, responsive center-chat/right-feature layout, resizable panels, and fresh private-room verification.", ["Trace create/join through proxy, server action, RPC, and RLS; fix the smallest real defect.", "Implement owner transfer before owner leave; enforce public/private rejoin semantics.", "Store room feature permissions and visibility server-side; reject disabled-feature API/realtime events.", "Use a layout state machine: default center chat, active feature plus right chat, disabled feature expands chat."], "rooms.ts, room route, RoomRealtimeProvider, useRoomSync, MembersTab, MediaStage, FilesTab, StudyStage, room settings.", "Membership/permission actions, feature settings, leave UI, layout components, panel persistence, targeted migration.", "Additive room settings/permission columns or normalized tables; preserve existing membership rows and storage.", "One room provider remains authoritative; feature events carry room identity and permission checks.", "Settings, leave confirmation, disabled/hidden feature states, loading/errors, mobile navigation, no empty black panels.", "Owner lockout, admin escalation, stale membership, feature API bypass, duplicated channels, layout regressions.", "Role matrix, direct RLS, two-user room tests, room refresh, expiry, feature disabled, owner transfer, responsive screenshots.", "Roll back new feature flags/layout while retaining existing room data and core room route.", "Create/join public/private, leave/rejoin, role changes, feature disable, center/right layout, mobile and desktop smoke.", ["Fresh private room matrix passes.", "Owner/admin/member rules are server, DB, and UI consistent.", "Leaving cleans membership, presence, subscriptions, and local state."])
story.append(PageBreak())
story += action(7, "Harden Shared Realtime and Watch", "P1", "PARTIAL", "Actions 1-2, 6", "Dependable collaboration", "Realtime is the shared nervous system of rooms. Watch and presence expose synchronization defects quickly.", "It depends on room identity, authorization, lifecycle, and layout; building social realtime first would repeat the same channel problems.", "Later Files, Study, Music, notifications, and groups all need one stable event and reconnection model.", "RoomRealtimeProvider and useRoomSync are present; duplicate room chat channel was removed in the recorded remediation; Watch uses React Player v3 source-level fixes. Runtime breadth is not fully proven.", "Preserve RoomRealtimeProvider, useRoomSync, useRoomPresence, MediaStage, player v3, native currentTime, pause/play behavior, and existing room event names unless a compatibility shim is necessary.", "Independent browser proof for play/pause/seek/presence, event dedupe, late joiners, reconnect recovery, permissions, uploaded/external media, subtitles and drift handling.", ["Define one event envelope with room ID, event ID, actor, timestamp, type, and payload validation.", "Broadcast local seek with throttling and remote-apply suppression; never rebroadcast a remote seek.", "On join/reconnect, fetch authoritative room state then subscribe; deduplicate events and remove listeners on unmount.", "Test provider behavior when room expires, a member is removed, or a feature is disabled."], "RoomRealtimeProvider, useRoomSync, useRoomPresence, MediaStage, react-player v3, current Supabase channels.", "Event schema/guards, reconnect state machine, watch synchronization tests, controlled feature permissions.", "Indexes or event logs only if needed; do not store sensitive provider tokens or private keys.", "One room-level provider/channel; future group provider can share the event contract without creating duplicate room channels.", "Show connecting/reconnecting/stale state, playback errors, seeking state, and feature-disabled feedback.", "Feedback loops, event flooding, stale state, duplicate subscriptions, unauthorized event injection, timer drift.", "Two independent persistent profiles; browser network inspection; join/leave/reconnect tests; unit tests for event reduction.", "Disable new advanced sync paths while preserving basic local playback and chat; revert only targeted event reducer changes.", "A/B play, pause, resume, seek in both directions, repeated seeks, late join, reload, network loss, presence leave/reload, no duplicate chat.", ["Two-user play/pause/seek passes with no loop.", "Presence has no ghost/duplicate members.", "Reconnect and late join recover authoritative state."])
story.append(PageBreak())
story += action(8, "Make Lifecycle, Recovery, Permanent Rooms, and Notifications Explicit", "P0", "PARTIAL", "Actions 1-2, 6", "Safe long-lived rooms and future group conversion", "Lifecycle errors can destroy access or falsely promise recovery. The product semantics are now precise enough to encode as a state machine.", "The current schema has expiry/reopen/recovery primitives, but exact 24-hour and 7-day semantics plus notification audience must be locked before more conversion work.", "Group conversion, cron cleanup, and permanent-room UX depend on knowing whether a room is active, expired, reopened, or permanent.", "recovery.ts, room-lifecycle.ts, cleanup route, 004 functions, permanent request/notification tables/functions exist in the recorded remediation; browser and cron proof remains open.", "Preserve service-role cleanup boundaries, RLS, recovery request state, active/reopened checks, room data, and irreversible deletion semantics.", "Verify/complete: expiry -> 24-hour request window -> owner/admin request/review -> approval reopens preserved data for exactly 7 days -> approved member may request permanent -> owner/admin approval makes permanent indefinitely; notification to legitimate prior users.", ["Represent original expiry, recovery-request deadline, reopened_until, and permanent state without fake future expiry.", "Make request identity fields immutable and status transition only pending -> approved/rejected.", "Approve only inside the 24-hour window; set reopened_until to approval time + 7 days.", "Allow current approved members to request permanence during reopen; owner/admin alone reviews; on approval clear temporary expiry and write scoped notifications.", "Make cleanup idempotent and never restore irreversibly destroyed data."], "004 security remediation, recovery actions, room lifecycle helper, cleanup route, room_notifications architecture, existing realtime.", "Any missing state fields/RPCs/triggers, permanent conversion notification UI, cron evidence, recovery browser flow.", "Only additive fields/constraints/functions; no DROP TABLE, TRUNCATE, bulk DELETE, or storage cleanup in migration 004/next design.", "Emit authorized lifecycle/notification events through existing provider; avoid notification channels to unrelated users.", "Clear expired, recovery window, reopened-until, permanent, request pending/rejected states; no fake date after permanent.", "Recovery bypass, owner/admin escalation, former-member regain, permanent room expiring, wrong notification audience, non-idempotent cleanup.", "Direct RPC/RLS matrix, time-controlled disposable room tests, browser owner/member flows, cron logs, notification audience query.", "Use forward-compatible status fields; if rollout fails, keep rooms in old safe expired behavior and disable new approval UI.", "Expiry, 24-hour deadline, 7-day deadline, unauthorized review, former member, permanent approval/rejection, notification, repeated cleanup.", ["Recovery window and 7-day reopen are observed live.", "Permanent state has no expiry date.", "Only legitimate prior users receive the permanent notification.", "Destroyed data is not resurrected."])
story.append(PageBreak())

# Actions 9-16
story += action(9, "Build Files, Media, and the Complete Lifecycle", "P1", "PARTIAL", "Actions 2, 6-8", "Reliable collaboration and Watch inputs", "Files are both a user feature and a storage-security boundary. They must have a clear lifecycle before media, music, or conversion reuses them.", "Storage policies and lifecycle semantics are upstream dependencies.", "A later storage rewrite would invalidate room attachments, media casting, group conversion, and music uploads.", "Temporary media, storage policies, media stage, Files tab, path-scoped RLS, and cleanup route exist.", "Preserve bucket privacy, room UUID path scoping, temporary media expiry, media references, and no public storage access.", "Permanent files/documents model, upload progress/retry/cancel, MIME/size validation, subtitles/metadata, 48-hour personal music retention abstraction, large-file strategy.", ["Document upload -> storage -> access -> use -> expiration -> deletion.", "Separate room/group storage references from personal uploads; do not duplicate large objects during conversion.", "Add signed access only after server authorization and active lifecycle checks.", "Make cleanup idempotent for abandoned, never-played, expired, and removed uploads."], "storage.ts, storage.objects policies, FilesTab, MediaStage, temporary_media, cleanup route.", "Upload service, metadata records, progress UI, cleanup metadata, provider-neutral storage interface.", "Additive metadata tables/indexes and policies; no broad bucket reset or content deletion.", "Emit file/stage state through the existing room provider; files remain private and permissioned.", "Progress, retry/cancel, unsupported-format, upload failure, expired, and access-denied states.", "Wrong storage path, signed URL leak, expired file playable, orphaned objects, unsafe MIME, conversion resurrecting deleted data.", "Direct storage/RLS tests, upload/download authorization, expiry cleanup, large-file smoke, stage two-user test.", "Disable new upload types while keeping existing file links; preserve object references and metadata for rollback.", "Member/non-member/expired storage reads, upload progress, stage propagation, abandoned cleanup, no private object download.", ["Files follow one documented lifecycle.", "Storage is private and room/group scoped.", "Expired or deleted content cannot be accessed or restored."])
story.append(PageBreak())
story += action(10, "Finish Study and Collaboration Tools", "P2", "PARTIAL", "Actions 6-9", "Notes, PDFs, whiteboard, lectures, history", "Study tools can now build on verified rooms, presence, files, and Focus Lock instead of creating a second collaboration foundation.", "They need lifecycle, storage, and realtime behavior to be secure.", "They are useful after core Watch/chat/files flows are reliable, but before the platform claims complete collaboration.", "Study sessions, StudyStage, Focus Lock, and related actions exist; notes/PDF/whiteboard breadth is incomplete or unverified.", "Preserve study timer state, Focus Lock cleanup, session history, room lifecycle, and current responsive behavior.", "Persistent notes, PDF viewer/annotations, whiteboard state, lecture records, collaborative editing rules, export/history, feature permissions.", ["Define which study objects are room-scoped, group-scoped, or personal.", "Use server actions and RLS for read/write; use optimistic UI only with reconciliation.", "Keep Focus Lock tied to route lifecycle and provide missing/expired-room escape paths.", "Add versioning or conflict handling only where simultaneous editing requires it."], "StudyStage, study actions/table, focus-lock helper, FilesTab/storage, RoomRealtimeProvider.", "Notes/PDF/whiteboard tables/components, conflict-safe actions, permissions, export controls.", "Additive tables/columns/indexes, strict ownership/membership policies.", "Share timer/session updates through the room provider; do not create feature-specific duplicate presence channels.", "Clear active/expired/locked/saved/error states, keyboard and mobile controls.", "Stale focus lock, unauthorized document reads, lost simultaneous edits, oversized realtime payloads.", "Focus Lock browser lifecycle, two-user timer/state tests, RLS, refresh/reconnect, accessibility.", "Ship each tool behind a feature flag; preserve study timer if new collaboration tools fail.", "Timer, refresh, leave, expiry, notes permissions, PDF file access, whiteboard two-user edit, mobile layout.", ["Study state is durable and permissioned.", "Focus Lock cannot trap navigation.", "New tools cannot read unrelated room data."])
story.append(PageBreak())
story += action(11, "Convert Rooms into Persistent Personal Groups", "P1", "PARTIAL", "Actions 2, 5, 6, 8", "Personal Groups, group chat, group workspace", "Conversion is a data migration boundary. It should happen only after room identity, membership, lifecycle, and Personal chat models are settled.", "Without a clear group model and product decision about retained room features, conversion could create duplicates or expose old members.", "Building conversion last would make existing rooms hard to migrate without user-visible interruption.", "convertRoomToGroup exists in src/actions/rooms.ts and recorded remediation includes conversion functions; current action is owner-only and semantics need confirmation.", "Preserve originating room ID, room display name, eligible non-deleted data, approved members, owner/admin roles where safe, storage references, and existing room data.", "One persistent group record, idempotent conversion lock, group members/roles/permissions, username removal, Personal list integration, workspace/back navigation, notification/result UI.", ["Confirm group feature surface: preserve data and optionally workspace features with explicit permissions, or create chat-only permanent groups.", "Authorize owner or admin with explicit conversion permission; exclude pending/rejected/removed/banned members.", "Create exactly one group keyed by originating_room_id; keep room name, remove room username/public link.", "Migrate references transactionally, preserve content eligibility, and redirect to group chat."], "convertRoomToGroup, room membership/RLS, existing messages/files/study metadata, Personal Chat list, RoomRealtimeProvider.", "Groups schema, group members/policies, conversion RPC/action, idempotency constraint, group UI and workspace.", "Additive group tables/foreign keys/unique originating_room_id; no room deletion or content resurrection.", "Reuse event envelope for conversion and group membership; keep group and room channels scoped.", "Conversion confirmation, progress/result, group in Groups and All, three-dot workspace menu, Back, permissions.", "Duplicate conversion, pending member migration, public username leak, old member access, partial transaction, group/room data confusion.", "Disposable room with owner/admin/member/pending/rejected; double-click/concurrent conversion; direct RLS; rollback test.", "Do not delete the originating room; if conversion fails, retain room and mark no group or safe pending state for retry.", "Owner/admin permission, one group, membership set, name/username, messages/files, expiry eligibility, group access, back navigation.", ["One safe retryable conversion exists.", "No public group username is created from the room username.", "Eligible members/data are preserved without resurrecting destroyed content."])
story.append(PageBreak())
story += action(12, "Deliver Personal and General Social Messaging", "P1", "MISSING", "Actions 4-5, 11", "A coherent daily social experience", "Once relationship and group data exist, the user can finally see a useful Personal/General inbox.", "It depends on profile relationships, conversation types, E2EE compatibility, and group membership.", "Waiting until advanced features would leave the main social destination undefined and make notification/unread work harder later.", "Messages page and private E2EE are present, but the required Personal Groups/All and General request model is not complete.", "Preserve existing E2EE private messages, key limitations, room chat separation, message ordering, and undecryptable state.", "Personal Groups/All lists, General contacts and requests, unread/read state, group messages, friend reclassification, search and empty states.", ["Build server queries that return only accepted friends/groups for Personal.", "Build General contact/request queries that enforce follow or accepted request.", "Use explicit conversation type and membership constraints; avoid duplicate one-to-one records.", "Add read/unread and realtime list updates with safe reconnect behavior."], "usePrivateChat, PrivateChat, messages page, notifications, existing RLS and realtime patterns.", "Personal/General layout, group chat, request inbox, conversation service, read state, mobile navigation.", "Additive conversation/group tables and policies, no room message table reuse without explicit scope.", "Use authorized channels for personal/group conversations; remove subscriptions when membership ends.", "Loading/empty/error/request states, friend/group icons, unread badges, accessible tabs.", "Cross-scope read, membership removal, duplicate conversations, request privacy, E2EE key mismatch.", "Four-account matrix, RLS direct queries, two-user messages, friendship reclassification, reload/reconnect.", "Route new tabs behind feature flag; existing private chat remains available while migration is validated.", "Groups only in Groups, friends/groups in All, non-friend General request, acceptance, history preservation, removed member.", ["Personal and General are visibly and technically separate.", "No non-member can read or send.", "Conversation history survives relationship change without duplication."])
story.append(PageBreak())
story += action(13, "Build the Personal Music Foundation", "P2", "MISSING", "Actions 2-5, 9", "Personal listening and future shared music", "Music depends on private storage, provider authorization, player capabilities, retention cleanup, and a clear token boundary.", "Provider and storage decisions must be made before UI promises unsupported playback.", "Room/group music will otherwise expose personal credentials or require a second player implementation.", "The master plan describes music, but a complete personal upload/provider system is not recorded as implemented.", "Preserve provider-neutral storage abstraction, server-side secret handling, existing media player patterns, and room privacy.", "Multi-file uploads, 48-hour personal retention, metadata/artwork, player queue, official provider OAuth/connect/disconnect/search/playlists, token refresh/revocation.", ["Implement upload storage behind an abstraction; keep it ready for future R2 without hard-coding R2.", "Validate MP3/FLAC/browser support and clearly reject unsupported formats or use an approved transcoder.", "Keep provider tokens server-side and use minimum scopes.", "Integrate only official APIs/SDKs; support metadata/redirect when a provider lacks public playback."], "storage abstraction, MediaStage patterns, cleanup scheduler, Supabase server actions.", "Music uploads/providers tables, encrypted token vault strategy, upload UI/player, provider adapters, cleanup.", "Additive music tables, expiration indexes, provider connection uniqueness, private storage policies.", "Personal music is private; room music receives only non-secret track references and approved shared state.", "Progress, metadata, unsupported format, provider unavailable, token refresh, disconnect, expiry, queue states.", "Provider terms, token leakage, downloaded-content restrictions, unplayable FLAC/Dolby, abandoned uploads, accidental provider cleanup.", "Provider sandbox accounts, storage/RLS, token redaction, 48-hour cleanup simulation, browser playback matrix.", "Disable individual provider adapters or uploads without removing existing room media; preserve metadata for retry.", "Upload one/many, progress/retry/cancel, MP3/FLAC, unsupported, 48-hour cleanup, provider connect/search/playlist/play.", ["Personal player works with supported sources.", "Provider limits are honestly shown.", "No provider token or private upload becomes visible to another user."])
story.append(PageBreak())
story += action(14, "Add Shared Music to Rooms and Groups", "P2", "MISSING", "Actions 7, 11, 13", "A complete shared activity surface", "Shared Music should reuse a proven player and event contract, not invent a second realtime architecture.", "It depends on personal/provider source abstractions, permissions, and room/group feature flags.", "Building it earlier would mix personal credentials with shared state and duplicate Watch synchronization logic.", "No complete room/group Music section is recorded as implemented.", "Preserve RoomRealtimeProvider, room/group permission model, private provider credentials, and current media/player handling.", "Dedicated Music section, shared queue/track/play/pause/seek state, control permissions, provider limitations, uploaded room music lifecycle.", ["Broadcast only sanitized track identity and playback state, never account tokens.", "Let owner/admin with permission control queue; allow members to listen as supported.", "Disable/hide Music through the same feature-permission path as Cast/Study/Files.", "Handle reconnect and late join by fetching authoritative current track/position."], "useRoomSync/RoomRealtimeProvider, MediaStage/player code, storage policies, feature settings.", "Shared music reducer/components, group workspace integration, provider playback policy UI.", "Optional shared_music_state tables/columns and feature settings; no duplicate room channel.", "Use current room/group provider and event dedupe; personal provider authorization stays server-side.", "Clear personal vs shared labels, permission errors, unavailable provider state, queue controls.", "Private token leak, state drift, unauthorized queue changes, provider playback restrictions, event flooding.", "Two-user play/pause/seek, permission matrix, reconnect, disabled feature, group workspace tests.", "Turn off shared Music feature while retaining personal player and room features.", "Room/member shared track, controller permissions, group shared state, no token exposure, late join.", ["Shared Music is a permissioned room/group feature.", "Personal credentials never cross the realtime boundary.", "Provider limitations are visible and accurate."])
story.append(PageBreak())
story += action(15, "Add Advanced Collaboration: Notes, Calls, AI, Scheduling, Moderation", "P2", "MISSING", "Actions 2, 4-14", "A differentiated collaborative platform", "These features are high value but high risk; they should come after identity, permissions, realtime, content lifecycle, and privacy are reliable.", "Calls and AI especially require stable identity, consent, moderation, and network architecture.", "They do not block the core room/social MVP and should not delay security and reliability work.", "Master plan concepts include voice/video calls, AI, polls, memories, scheduling/history, moderation, and temporary P2P links; full implementations are not recorded.", "Preserve E2EE boundaries, room roles, shared provider, storage privacy, Focus Lock, and no automatic AI access to private content.", "Managed SFU calls, consent and device permissions, AI opt-in workflows, scheduling, polls, memories, moderation/reporting, expiring links.", ["Choose managed SFU for calls; authenticate room membership and avoid exposing raw peer topology unnecessarily.", "Require explicit consent before AI processes messages/media; support deletion and retention controls.", "Build moderation actions with server/RLS auditability and appeal-safe states.", "Add scheduling/polls/memories only with scoped room/group ownership and expiration rules."], "Room membership/RLS, shared realtime, notifications, storage lifecycle, existing E2EE design.", "Call provider adapter, AI service boundary, moderation tables/actions, scheduling UI, audit events.", "Additive tables/policies, provider secrets server-side, retention indexes.", "Call presence and control events use authorized scoped channels; large/secret payloads stay off realtime.", "Permission prompts, consent, recording/AI indicators, report/block states, empty and failure states.", "Call credential leakage, AI plaintext access, harassment, notification spam, unbounded retention, provider outage.", "Threat modeling, privacy review, abuse tests, two-user call staging, AI consent tests, retention/erasure tests.", "Disable each advanced module independently; retain room/chat and data if provider fails.", "Join/leave calls, revoked membership, AI opt-in, report/block, scheduled event, notification scope, link expiry.", ["Each module has a documented provider, consent, retention, authorization, and rollback plan.", "No advanced feature weakens E2EE, RLS, or room lifecycle."])
story.append(PageBreak())
story += action(16, "Harden Mobile, Performance, Observability, and Technical Debt", "P1", "PARTIAL", "Actions 1-15", "Reliable production operations", "Once flows are stable, remove measured bottlenecks and make failures diagnosable without logging secrets.", "Premature optimization or broad dead-code cleanup can destabilize the foundation.", "Shipping social/music/calls without mobile and operational proof creates expensive support debt.", "Dynamic imports and some cleanup exist; Action 10 removed dead application writer/path; current lint warnings were reported as pre-existing.", "Preserve current live routes, shared provider, E2EE, room lifecycle, and existing desktop behavior while measuring before changing.", "Mobile navigation/layout tests, query pagination, subscription counts, caching, bundle review, structured redacted logging, error monitoring, targeted debt cleanup.", ["Measure bundle and route performance before changing imports.", "Paginate messages/files, remove unnecessary polling, and bound realtime payloads.", "Use dynamic imports for heavy Watch/PDF/whiteboard/music modules where safe.", "Clean only proven dead code after reference search; do not delete legacy files merely because they look old.", "Add redacted correlation IDs and metrics for failures without ciphertext, plaintext, tokens, or keys."], "Next config, dynamic imports, existing hooks/providers, Action 10 cleanup, current lint/type system.", "Performance budgets, mobile shell, monitoring adapters, tests, documented deprecation process.", "Indexes based on query plans; no data deletion for performance; no broad refactor.", "Track channel lifecycle and reconnect metrics without recording private payloads.", "Responsive room shell, touch controls, drawer navigation, resizable panels, accessible focus states.", "Over-optimization, hidden race conditions, logging sensitive data, mobile-only layout regressions.", "Lighthouse/route timing, device matrix, subscription leak test, log review, bundle analysis, diff review.", "Revert one optimization at a time; keep feature flag for new mobile shell or heavy module.", "Desktop/mobile room, Watch, chat, files, study, login; performance budgets; no sensitive log audit.", ["Measured bottlenecks improve without functional regressions.", "Mobile critical flows are usable.", "Operational logs are useful and safe."])
story.append(PageBreak())

# Dedicated roadmaps
story += section("SECURITY ROADMAP", "Issue -> risk -> fix -> current status -> verification -> production status")
security_rows = [
    ["Authentication / sessions", "Stale SSR cookies or unsafe redirects", "Use Supabase SSR proxy refresh, safe next allowlist, Google OAuth callback", "Source present; true refresh and Google onboarding unverified", "Login/logout, refresh, protected route, callback tests", "Open until live evidence"],
    ["Anonymous private data", "Public users read room membership/messages/media", "RLS active-room/member policies; no public private SELECT", "Earlier live probes reported pass; recheck after current changes", "Anonymous direct probes", "P0 gate"],
    ["Room membership", "Self-promotion or access after removal", "Identity/role immutability, owner/admin management, approved membership", "Migration remediation exists", "Role matrix incl. pending/rejected/former", "Must remain closed"],
    ["Message mutation", "Non-sender or former member deletes/updates", "UPDATE RLS requires current approved member, active/reopened room, sender; scope trigger", "Action 5 DB checks reported pass", "Direct UPDATE plus UI propagation", "P0 regression gate"],
    ["Storage", "Wrong path or public object access", "Use storage.objects.name UUID room path and active member checks", "Migration docs/state exist; verify canonical/live", "Anonymous/non-member/expired object reads", "Open until rechecked"],
    ["E2EE", "Private keys/plaintext/ciphertext leak or one bad message crashes list", "Device-side keys, Promise.allSettled, undecryptable state, redacted errors", "Source implemented; runtime mixed-key test open", "Refresh, missing/rotated key, browser log audit", "Open runtime proof"],
    ["Realtime authorization", "Unauthorized events or stale membership access", "Scoped channels, membership checks, dedupe, cleanup", "Shared room provider source present", "Removed member, reconnect, duplicate events", "Open runtime breadth"],
    ["Expiry/recovery", "Expired room remains visible or recovery bypasses lifecycle", "Server/RLS lifecycle checks, bounded approval, idempotent cleanup", "Source/direct tests reported; browser/cron open", "Time-controlled disposable room", "P0/P1 gate"],
    ["Privilege escalation", "Admin performs owner-only operation", "Granular permissions in action + RLS/RPC", "Owner-only conversion currently noted; product decision open", "Owner/admin/member/requester matrix", "Open for group/admin expansion"],
    ["Logging", "Operational logs expose secrets", "Redact keys, tokens, plaintext, ciphertext and raw crypto errors", "Raw crypto logging remediation reported", "Static search plus browser/server log review", "Keep closed"],
]
story.append(table(["Area", "Issue / risk", "Fix", "Current status", "Verification", "Production status"], security_rows, [78, 100, 125, 100, 70, 47]))
story += [PageBreak()]

story += section("SUPABASE AND DATA ROADMAP")
story += sub("Migration discipline")
story += bullets([
    "Base schema 01_schema.sql is a reference snapshot and contains older policy definitions; POLICIES.md and ordered migrations describe the intended effective state. Keep them aligned so future developers do not recreate insecure policies.",
    "002_rls_lockdown.sql establishes membership, room, messages, storage, media, reactions, and study restrictions. 003_room_lifecycle.sql adds server-enforced lifecycle behavior. 004_security_remediation.sql adds final security/lifecycle/recovery/permanent-room protections. 005_restore_room_creation_policy.sql is locally present and must be confirmed against the remote database before future deployment decisions.",
    "Migrations must be additive and reversible where possible. Never reset the linked database, replay already-applied migrations, drop room_messages merely because its writer is gone, or include cleanup/data deletion inside a security migration.",
])
schema_rows = [
    ["Rooms / memberships", "rooms, room_members", "Active/reopened/permanent access, approved membership, immutable identity/role scope", "Owner/admin/member matrix; expired room denial; ownership transfer"],
    ["Messages", "messages, private_chats, room_messages", "Room scope, sender ownership, E2EE ciphertext opaque to server", "Direct SELECT/INSERT/UPDATE and delete propagation"],
    ["Lifecycle", "rooms, recovery_requests, room_permanent_requests", "Original expiry, 24-hour request deadline, reopened_until, permanent status, immutable requests", "Time-controlled state transitions and idempotent cleanup"],
    ["Storage/media", "storage.objects, temporary_media", "UUID path, active member, lifecycle, expiry", "Anonymous/non-member/former/expired object reads"],
    ["Notifications", "room_notifications and future social notifications", "Only legitimate room users, no unrelated reads", "Permanent conversion notification audience"],
    ["Future social", "profiles, follows, friends, conversations, groups", "Explicit status, unique pairs, member-only reads/writes", "RLS matrix and duplicate prevention"],
]
story.append(table(["Domain", "Objects", "Required database behavior", "Verification"], schema_rows, [92, 135, 180, 93]))
story += sub("Data safety rules")
story += bullets([
    "Before a schema change: inspect current columns, constraints, indexes, policies, functions, triggers, grants, and real data shape without exposing user content.",
    "For a new relationship, use UUID foreign keys, explicit status checks, unique constraints, normalized friendship ordering, and indexes justified by query paths.",
    "For conversion: preserve references instead of duplicating large objects, exclude pending/rejected/removed members, and never resurrect content that the lifecycle has irreversibly destroyed.",
    "For cleanup: use a trusted scheduler secret, bounded batches, safe room/object path checks, idempotent behavior, and logs that contain counts/IDs only as appropriate - never secrets or private content.",
])
story += [PageBreak()]

story += section("REALTIME ARCHITECTURE ROADMAP")
story += sub("Simple explanation")
story += [P("Realtime is the mechanism that lets one browser hear about a change made by another browser. OmniLume should have one shared room-level manager that owns the room subscription and exposes safe state to Chat, Watch, Files, Study, presence, notifications, and future Music. Components should not each open their own room channel.", "Bodyx")]
rt_rows = [
    ["Already fixed in source", "Shared RoomRealtimeProvider/useRoomSync path; duplicate RoomChat room channel removed; presence moved to room-level architecture."],
    ["Requires runtime verification", "Two isolated profiles for chat, delete, Watch, seek, presence, file staging, reconnect, late join, reload and membership removal."],
    ["Still needs implementation", "Typed event envelope/guards, authoritative state recovery, dedupe IDs, reconnect handling, future group/social/music channels with explicit scope."],
]
story.append(table(["Evidence level", "State"], rt_rows, [125, 375]))
story += sub("Event rules")
story += bullets([
    "Every event should identify scope, event ID, actor, type, and validated payload. The server must reject events from users who are not currently authorized.",
    "Local Watch seek is broadcast once. A remote seek is applied with a suppression flag and is never rebroadcast. Throttle noisy events and prefer authoritative state on reconnect.",
    "Subscriptions must be removed on unmount, leave, expiry, and membership removal. Duplicate messages or presence events should be deduplicated by stable IDs.",
    "Large files, provider tokens, private keys, plaintext messages, and sensitive errors do not belong in realtime payloads.",
])
story += [PageBreak()]

story += section("WATCH ROADMAP")
watch_rows = [
    ["WATCH FOUNDATION", "React Player v3, src instead of url, native currentTime, no getInternalPlayer/config.file/as any, dynamic loading, player error state, native track subtitles where suitable.", "Player mounts, loads, plays and reports errors without obsolete v2 APIs."],
    ["WATCH MVP", "Shared play/pause/seek, local seek broadcast, remote seek suppression, pause/resume around seek, room permissions, authoritative state for late joiners, external and uploaded media.", "Two isolated users can watch and seek in both directions with no feedback loop."],
    ["WATCH ADVANCED", "Drift correction, playback speed policy, audio/subtitle preferences, reconnect recovery, provider/media limitations, host/admin controls, network loss, mobile controls.", "State recovers predictably and limitations are shown rather than hidden."],
]
story.append(table(["Stage", "Scope", "Complete when"], watch_rows, [100, 280, 120]))
story += sub("Watch verification checklist")
story += bullets([
    "A plays, pauses, resumes; B follows. Then B controls the same sequence and A follows.",
    "A seeks and B follows; B seeks and A follows; repeat several times while observing no recursive broadcast or event flood.",
    "Reload/late join obtains current track, position, playing state, speed, subtitles, and permission state.",
    "Feature disabled, expired room, removed member, unsupported source, uploaded file, external source, and mobile viewport are all safe and truthful.",
])
story += [PageBreak()]

story += section("CHAT AND MESSAGING ROADMAP")
chat_rows = [
    ["Room chat", "Room-scoped collaboration messages, reactions, attachments, deletion, moderation, realtime delivery.", "Membership/lifecycle RLS; Action 5 sender/authorized deletion; no public read."],
    ["Private E2EE", "One-to-one encrypted messages; keys/device state remain client-side; server stores ciphertext/public keys only as designed.", "No plaintext fallback; Promise.allSettled per message; undecryptable state; safe logs."],
    ["Personal / General", "Friend conversations in Personal; non-friend follow/request conversations in General; group chat in Personal.", "Relationship/request/group member RLS; explicit conversation types; no duplicate history."],
]
story.append(table(["System", "Purpose", "Security and completion rule"], chat_rows, [95, 220, 185]))
story += sub("E2EE limitations to document")
story += bullets([
    "Messages are decrypted on the user device. The server cannot recover a message when the required private key is unavailable.",
    "A missing, changed, rotated, corrupted, or unavailable key can make one message undecryptable. That message must remain represented safely, while other messages remain usable.",
    "Messages encrypted for an older key may require re-keying or resending. A new key does not automatically decrypt older messages.",
    "Multi-device access, key backup, and recovery remain limited unless separately implemented and approved. Adding a second device does not guarantee access to all older messages.",
])
story += [PageBreak()]

story += section("FILES, MEDIA, AND STUDY ROADMAP")
story += sub("File lifecycle")
story.append(P("upload -> storage -> authorized access -> use/stage -> expiration -> deletion", "H2x"))
story += bullets([
    "Temporary media is room-scoped and subject to active/reopened access. Permanent or personal files require an explicit retention policy.",
    "Signed links must be generated only after server authorization. The object path must be validated against the room or group identity.",
    "Uploads need progress, retry, cancellation, type/size validation, abandoned-upload cleanup, and clear expired states.",
    "Casting must preserve references and metadata without making objects public; staging events are room-scoped and permissioned.",
])
story += sub("Study and collaboration")
story += bullets([
    "Study timer and Focus Lock are existing foundations. Verify mount/unmount, expired/missing room escape, refresh, and sidebar recovery before adding more tools.",
    "Notes, PDF, whiteboard, lecture records, and history should be explicit room/group or personal data domains with their own RLS, not broad room access.",
    "Collaborative editing needs conflict handling only where simultaneous edits are real; otherwise use server actions with authoritative reload and simple optimistic feedback.",
])
story += sub("Current -> target")
story.append(table(["Area", "CURRENT STATE", "CHANGES REQUIRED", "TARGET"], [
    ["Files", "Temporary media and private storage exist", "Verify paths, expiry, progress, cleanup, stage", "Private, reliable file lifecycle"],
    ["Study", "Timer/Focus Lock exist", "Verify lifecycle, add notes/PDF/whiteboard selectively", "Permissioned collaborative study space"],
    ["Media", "Watch/Files components exist", "Unify metadata, subtitles, sources and storage limits", "Truthful, synchronized media experience"],
], [70, 150, 160, 120]))
story += [PageBreak()]

# Social and music
story += section("SOCIAL ROADMAP")
story += bullets([
    "Profile identity: Google account, required setup fields, lowercase unique username if retained, public/private visibility, safe DOB/gender defaults, picture, bio, and later editing.",
    "Followers: directional relationship. Public profiles accept immediately; private profiles create a request. Pending users do not count as accepted followers.",
    "Friends: a separate mutual relationship. A friend request is always required. Acceptance creates mutual friendship and safely creates mutual follows. Public friend count/list is not shown.",
    "Posts and lists: public visibility follows the profile model; private posts/follower/following lists are limited to accepted followers or friends. Requests are visible only to the involved users.",
    "Do not automatically treat a friend as a follower relationship in application logic without writing the two directional rows; do not delete follows silently when friendship is removed unless explicitly decided.",
])
story += [callout("PRODUCT DECISION", "Confirm whether username remains the universal public identity for profiles while room usernames are removed on conversion. The master plan and latest product prompt differ on some group-identity details; the latest approved requirement should be recorded before schema design.", colors.HexColor("#FFF7ED"), AMBER)]
story += [PageBreak()]

story += section("MUSIC ROADMAP")
music_rows = [
    ["1. Player foundation", "HTML audio capability, source abstraction, play/pause/seek/volume/mute, artwork and metadata", "No provider or room sync yet"],
    ["2. Personal uploads", "Multiple files, progress/retry/cancel, MP3/FLAC/browser compatibility, 48-hour expiry and cleanup", "Provider-neutral storage"],
    ["3. Provider connections", "Spotify, Apple Music, TIDAL, Qobuz, YouTube Music through official OAuth/SDK/API", "Tokens server-side, minimum scopes"],
    ["4. Search/playlists", "Selected-provider search, playlists/albums/artists/tracks, provider labels, reconnect/revocation", "Official playback only where permitted"],
    ["5. Room/group Music", "Shared track/queue/playback state beside other features", "Reuse shared realtime and permissions"],
    ["6. Advanced", "Queue, shuffle, repeat, persistent navigation, artwork, accessibility, mobile", "Measure before optimizing"],
]
story.append(table(["Stage", "Build", "Boundary"], music_rows, [105, 270, 125]))
story += sub("Provider limitations")
story += bullets([
    "Do not scrape provider sites, download protected content, or promise playback where the official API/SDK does not allow it.",
    "If a provider supports search, metadata, playlists, or redirect but not public playback, provide only that supported capability and explain the limitation.",
    "Connecting providers is personal. Room/group state can share a sanitized track reference and playback state, but never provider tokens, private playlists, or account details.",
    "Personal uploads remain on the server for 48 hours per the current product requirement, including abandoned uploads, then metadata and objects are deleted or marked expired. This is separate from provider-hosted content.",
])
story += [PageBreak()]

# Advanced/mobile/perf/code quality
story += section("ADVANCED FEATURES, MOBILE, AND PERFORMANCE")
adv_rows = [
    ["Calls", "Voice/video rooms via managed SFU, device permissions, participant roles, leave/reconnect", "Identity, room authorization, moderation, network testing"],
    ["AI", "Opt-in summaries, discovery, assistance, or study support", "Explicit consent; no automatic access to E2EE plaintext"],
    ["Scheduling/history", "Polls, reminders, memories, event history, notification controls", "Notification privacy, lifecycle retention, timezone handling"],
    ["Moderation", "Report/block, admin action, audit trail, appeal-safe states", "Granular permissions and abuse threat model"],
    ["Temporary links/P2P", "Short-lived sharing or direct transfer where appropriate", "Expiry, authorization, no accidental public data"],
]
story.append(table(["Feature", "What it is", "Dependencies / risk boundary"], adv_rows, [90, 245, 165]))
story += sub("Mobile plan")
story += bullets([
    "Use a mobile navigation drawer or bottom navigation for Rooms, Personal Chats, Music, Profile, and Explore.",
    "Use a full-screen feature workspace with a collapsible chat drawer; keep touch-sized controls for Watch, files, study, and room settings.",
    "Test keyboard behavior, viewport resizing, upload interruption, audio background limits, scroll restoration, and Focus Lock escape on real iOS/Android browsers.",
])
story += sub("Performance plan")
story += bullets([
    "Paginate message history and file lists, avoid repeated full-room queries, bound realtime payloads, and remove unnecessary polling.",
    "Dynamically load heavy Watch/PDF/whiteboard/music modules after measuring route bundles and Largest Contentful Paint.",
    "Track channel counts, subscription cleanup, query timings, upload latency, and media errors with redacted structured telemetry.",
])
story += [PageBreak()]

story += section("CODE QUALITY AND TECHNICAL DEBT")
story += sub("Fix now")
story += bullets([
    "Keep strong types around player APIs, server action inputs, lifecycle states, relationship statuses, and realtime events.",
    "Keep crypto logging redacted; remove raw console.error(err) in crypto flows and audit all new error paths.",
    "Maintain exactly one authoritative room realtime path and one authoritative Delete for Everyone path.",
    "Do not reintroduce the legacy room_messages application writer. The table can remain if database compatibility or history requires it.",
    "Resolve remediation-caused lint/type/build errors; classify pre-existing warnings separately.",
])
story += sub("Fix later, with evidence")
story += bullets([
    "Remove genuinely unreachable legacy components only after import, export, dynamic reference, test, and route searches.",
    "Consolidate helpers only when duplicate behavior is proven; avoid broad renames during security or lifecycle changes.",
    "Add unit tests around pure reducers, lifecycle state transitions, permission matrices, decryption mapping, and event dedupe before expanding feature surface.",
])
story += [PageBreak()]

# Testing ladder
story += section("TESTING ROADMAP", "Each level proves something different. Passing Level 1 does not prove Level 5.")
test_rows = [
    ["LEVEL 1", "Static validation", "npx tsc --noEmit; npm run build; npm run lint; git diff --check; targeted searches", "The code is internally consistent and no obvious prohibited pattern remains."],
    ["LEVEL 2", "Unit tests", "Pure lifecycle, permission, reducer, decryption, validation, event dedupe tests", "Small logic behaves correctly without a browser or remote database."],
    ["LEVEL 3", "Database/RLS", "Anonymous and role matrix direct queries, storage, functions, triggers, migration state", "Database blocks bypasses independently of UI/server actions."],
    ["LEVEL 4", "Authenticated integration", "Server actions/API, session refresh, room lifecycle, recovery, cleanup, provider mocks", "App boundary and database agree for authenticated users."],
    ["LEVEL 5", "Two-user realtime", "Separate persistent browser profiles for chat, delete, presence, Watch, seek, files", "One user observes another user’s authorized change without duplicates or loops."],
    ["LEVEL 6", "Browser UX", "Loading/error/empty states, navigation, Focus Lock, mobile, E2EE failure, accessibility", "A real user can recover from normal failure and lifecycle states."],
    ["LEVEL 7", "Staging/production", "Vercel deployment, live Supabase probes, cron logs, smoke and rollback checks", "The deployed environment matches tested code and operational assumptions."],
]
story.append(table(["Level", "Name", "Examples", "What it proves"], test_rows, [53, 90, 232, 125]))
story += sub("Regression protection checklist")
check_items = [
    "Authentication and login/logout", "Room creation and joining", "Membership and roles", "Private E2EE messaging", "Room chat and delete", "Realtime/presence", "Watch/playback/seek", "Files/storage/casting", "Study/Focus Lock", "Expiry/recovery/permanent state", "Navigation and responsive desktop", "No secret/plaintext/ciphertext-sensitive logs", "Canonical schema and migration alignment", "Cron/cleanup evidence", "Notifications and privacy scope",
]
for i in range(0, len(check_items), 3):
    story.append(Table([[P("[ ] " + x, "Smallx") for x in check_items[i:i+3]]], colWidths=[166] * len(check_items[i:i+3]), style=TableStyle([("VALIGN", (0,0), (-1,-1), "TOP"), ("BOX", (0,0), (-1,-1), 0.35, LINE), ("INNERGRID", (0,0), (-1,-1), 0.35, LINE), ("BACKGROUND", (0,0), (-1,-1), PAPER), ("LEFTPADDING", (0,0), (-1,-1), 7), ("RIGHTPADDING", (0,0), (-1,-1), 7), ("TOPPADDING", (0,0), (-1,-1), 5), ("BOTTOMPADDING", (0,0), (-1,-1), 5)])))
story += [PageBreak()]

# Master feature table
story += section("MASTER FEATURE TABLE")
features = [
    ["01", "Foundation / architecture", "Shared Next.js/Supabase base, typed actions, storage abstraction", "PARTIAL", "P0", "Current codebase", "01", "Inventory, current 403, remote truth"],
    ["02", "Auth and Google onboarding", "Google sign-in, callback, sessions, setup gate", "PARTIAL", "P0", "Foundation", "03", "Provider config and profile setup"],
    ["03", "Profiles and privacy", "Public/private profile, picture, bio, username, posts", "MISSING", "P1", "Auth", "04", "Schema, RLS, profile UI"],
    ["04", "Followers and friends", "Directional follows, mutual friends, requests", "MISSING", "P1", "Profiles", "04", "Relationship schema and matrix"],
    ["05", "Rooms and membership", "Create/join, public/private, roles, leave", "PARTIAL", "P0", "Security", "06", "Fresh private-room proof"],
    ["06", "Shared realtime/presence", "One room provider, dedupe, reconnect, presence", "PARTIAL", "P1", "Rooms", "07", "Independent browser proof"],
    ["07", "Room chat/delete", "Room messages, reactions, deletion, attachments", "DONE core", "P0", "Rooms/realtime", "07", "Regression breadth"],
    ["08", "Private E2EE chat", "Device-side keys, tolerance, undecryptable state", "DONE source", "P0", "Auth", "05", "Mixed runtime proof"],
    ["09", "Watch", "Synchronized media, play/pause/seek/subtitles", "PARTIAL", "P1", "Realtime", "07", "Two-user complete test"],
    ["10", "Files/media", "Private storage, casting, expiry, cleanup", "PARTIAL", "P1", "RLS/rooms", "09", "Lifecycle and large-file proof"],
    ["11", "Study/collaboration", "Timer, Focus Lock, notes, PDF, whiteboard", "PARTIAL", "P2", "Files/realtime", "10", "Selective tool implementation"],
    ["12", "Recovery/permanent rooms", "24-hour request, 7-day reopen, permanent conversion", "PARTIAL", "P0", "Lifecycle/RLS", "08", "Browser/cron/notification proof"],
    ["13", "Personal/General chat", "Friend, non-friend requests, groups, unread", "MISSING", "P1", "Social/E2EE", "12", "Conversation model"],
    ["14", "Room-to-group conversion", "Idempotent conversion, preserved data/members", "PARTIAL", "P1", "Lifecycle/social", "11", "Resolve group semantics"],
    ["15", "Personal Music", "Uploads, 48-hour retention, provider connections", "MISSING", "P2", "Storage/auth", "13", "Official provider adapters"],
    ["16", "Room/group Music", "Shared queue and playback", "MISSING", "P2", "Realtime/music", "14", "Permissioned shared state"],
    ["17", "Calls/AI/scheduling", "Advanced collaboration and assistance", "MISSING", "P2", "Core/social", "15", "Consent/provider choices"],
    ["18", "Mobile/performance", "Responsive workflows, budgets, no leaks", "PARTIAL", "P1", "Core flows", "16", "Real device/measurement"],
    ["19", "Deployment/operations", "Migrations, cron, monitoring, rollback", "PARTIAL", "P0", "All launch scope", "17", "Live evidence"],
]
story.append(table(["#", "Feature", "What it is", "Status", "Pri", "Depends", "Stage", "What remains"], features, [23, 82, 138, 52, 28, 73, 32, 72]))
story += [PageBreak()]

# Master action table
story += section("MASTER ACTION TABLE")
actions = [
    ["01", "Secure and stabilize foundation", "P0", "PARTIAL", "Current code", "All features", "Verified inventory, no unexplained P0 gap"],
    ["02", "Reconcile database security/schema", "P0", "PARTIAL", "01", "Safe data and permissions", "Live policies/functions match intended state"],
    ["03", "Finish Google auth/profile onboarding", "P0", "MISSING", "01-02", "Stable identity", "New/existing OAuth users route correctly"],
    ["04", "Profiles, follows, friends", "P1", "MISSING", "03", "Social permissions", "Privacy and relationship matrix passes"],
    ["05", "Personal/General chat", "P1", "MISSING", "02-04", "Daily messaging", "No cross-scope reads; E2EE preserved"],
    ["06", "Room membership/permissions/layout", "P1", "PARTIAL", "02", "Reliable rooms", "Fresh private-room matrix and roles pass"],
    ["07", "Realtime and Watch", "P1", "PARTIAL", "02/06", "Multi-user collaboration", "Independent A/B play/seek/presence pass"],
    ["08", "Lifecycle/recovery/permanent", "P0", "PARTIAL", "02/06", "Safe retention", "24h/7d/permanent/notification pass"],
    ["09", "Files/media lifecycle", "P1", "PARTIAL", "02/06/08", "Content collaboration", "Private upload/use/expiry/delete verified"],
    ["10", "Study and collaboration tools", "P2", "PARTIAL", "06-09", "Learning workflows", "Focus Lock and tool permissions pass"],
    ["11", "Room-to-group conversion", "P1", "PARTIAL", "05/08/09", "Persistent groups", "One safe, eligible, retryable conversion"],
    ["12", "Social inbox and groups", "P1", "MISSING", "04/05/11", "Personal Chat", "Personal/General UX and RLS pass"],
    ["13", "Personal Music", "P2", "MISSING", "02/09", "Private listening", "Official adapters and 48h upload cleanup"],
    ["14", "Room/group Music", "P2", "MISSING", "07/11/13", "Shared music", "Permissioned sanitized shared state"],
    ["15", "Calls/AI/scheduling/moderation", "P2", "MISSING", "02-14", "Advanced platform", "Privacy/provider/abuse gates pass"],
    ["16", "Mobile/performance/operations", "P1", "PARTIAL", "01-15", "Production reliability", "Measured budgets, device proof, monitoring"],
]
story.append(table(["Order", "Action", "Priority", "Status", "Dependencies", "Unlocks", "Definition of done"], actions, [35, 145, 45, 58, 80, 80, 57]))
story += [PageBreak()]

# Next 10
story += section("NEXT 10 ACTIONS", "These are the best immediate moves from the latest recorded remediation state.")
next10 = [
    ["1", "Resolve product decisions", "Conflicting group feature semantics, Google-only vs legacy login, exact profile fields, username rules, and provider limitations must be written down.", "A signed decision record that prevents schema rework.", "Unblocks identity, group, and music design."],
    ["2", "Reproduce and resolve the room-creation 403", "A fresh private-room test is a release/security blocker.", "A traced request and, if needed, smallest safe fix with fresh isolation matrix.", "Unblocks trusted room and RLS testing."],
    ["3", "Reconcile canonical schema and migration 005", "Ensure future developers and the live database do not diverge from effective policy state.", "Current remote 002-005 evidence and updated canonical docs if stale.", "Unblocks safe migrations."],
    ["4", "Implement Google OAuth callback and config guide", "Stable identity is required before social data exists.", "New and existing Google users route safely through setup/home.", "Unblocks profiles."],
    ["5", "Implement profile setup/privacy/username", "Users need a stable privacy-aware identity.", "Validated profile creation/editing with RLS and safe defaults.", "Unblocks social graph."],
    ["6", "Implement follows/friends and RLS", "Relationship state controls discovery and General chat.", "Public/private tests, requests, mutual friendship, no duplicates.", "Unblocks Personal/General."],
    ["7", "Define Personal/General conversation model", "Do not mix room messages, E2EE private chat, General requests, and groups.", "Conversation types, access actions, lists, and E2EE compatibility plan.", "Unblocks daily social experience."],
    ["8", "Finish room permissions/leave/feature flags", "Rooms are the existing product anchor and group conversion depends on them.", "Owner/admin/member matrix and disabled-feature API denial.", "Unblocks safe conversion."],
    ["9", "Complete independent Watch/presence/browser proof", "Source-level sync is not production evidence.", "Two profiles prove play/pause/seek/presence/reconnect behavior.", "Unblocks collaboration confidence."],
    ["10", "Build file/music readiness plan and operational tests", "Storage and provider privacy must precede Music and room shared media.", "Provider-neutral upload/lifecycle design, cleanup evidence, and performance/mobile scope.", "Unblocks Music without token or retention mistakes."],
]
story.append(table(["#", "Action", "Why now", "Expected result", "What it unlocks"], next10, [25, 115, 150, 145, 65]))
story += [PageBreak()]

# Release gates
story += section("RELEASE GATES")
gates = [
    ["GATE 1", "Secure foundation", "Current repo/remote migration state known; anonymous private-data probes denied; direct RLS role matrix passes; no critical secret/log issue."],
    ["GATE 2", "Core room experience", "Create/join/leave/roles/settings, room chat/delete, storage, lifecycle, navigation, and shared provider pass in disposable tests."],
    ["GATE 3", "Watch experience", "React Player v3, play/pause/seek, subtitles/source errors, late join/reconnect, and independent two-user sync pass."],
    ["GATE 4", "Collaboration", "Files, Study, Focus Lock, notes/PDF/whiteboard, room feature flags, cleanup, and mobile critical flows pass."],
    ["GATE 5", "Social and groups", "Google/profile/privacy, follow/friend, Personal/General, room conversion, group permissions, and notification privacy pass."],
    ["GATE 6", "Music and advanced", "Personal uploads/providers, 48-hour cleanup, shared Music, calls/AI/scheduling/moderation each has an approved privacy/provider plan."],
    ["GATE 7", "Production ready", "Deployed commit equals tested commit; migrations/cron verified; rollback/monitoring documented; all required runtime/security evidence recorded."],
]
story.append(table(["Gate", "Name", "Required evidence"], gates, [65, 125, 310]))
story += sub("Production readiness checklist")
readiness_sections = {
    "PRODUCT": ["Core user flows work", "Rooms, chat, Watch, Files, Study work", "Personal/General social scope is intentionally released or clearly deferred", "User-facing limitations are honest"],
    "SECURITY": ["No anonymous private data", "RLS and storage direct tests pass", "Former/pending/rejected/unrelated users are blocked", "No secret/plaintext/private-key leakage", "Realtime authorization is scoped"],
    "DATABASE": ["Migrations and live objects match", "Canonical schema/docs are not stale", "Expiry, recovery, permanent state, cleanup are verified", "No destructive migration surprise"],
    "REALTIME": ["Independent two-user chat/presence/Watch tests", "No duplicate channels", "Reconnect/late join state recovery", "Delete and feature events are authorized"],
    "UX / OPERATIONS": ["Loading, empty, error, disabled states", "Desktop/mobile critical flows", "Cron execution evidence", "Monitoring and rollback", "TypeScript/build/lint/diff checks"],
}
for name, items in readiness_sections.items():
    story.append(P(name, "H3x"))
    story += bullets(["[ ] " + x for x in items], "Smallx")
story += [callout("VERDICT", "PRODUCTION READY: NO for the complete OmniLume vision at the latest recorded state. The remediated room foundation may be close to release after current live/runtime gates are re-run, but Google onboarding, profile/social systems, Personal/General chat, group semantics, Music, and several independent runtime checks remain open.", colors.HexColor("#FEE2E2"), RED)]

# Final assumptions and source map
story += section("FINAL IMPLEMENTATION PRINCIPLES")
story += bullets([
    "Extend first. Improve second. Refactor only when needed. Rewrite only when the current architecture cannot safely support the requirement.",
    "Treat database changes as high risk. Prefer additive, backward-compatible, staged migrations and direct authorization tests.",
    "Treat source existence, static checks, local runtime, multi-user runtime, database/security evidence, and production evidence as separate claims.",
    "Do not use the browser UI as the security boundary. Server actions, database RLS, storage policies, constraints, and authorized realtime checks must agree.",
    "Do not claim provider playback, data recovery, or message recovery where the official provider, lifecycle state, or device key model cannot support it.",
    "Do not delete existing production data as part of feature development. Use disposable rooms/accounts and narrowly scoped cleanup tests.",
])
story += sub("Repository source map")
source_rows = [
    ["Routes", "src/app/page.tsx, login, explore, create-room, room/[id], messages, home, api/internal/cleanup-expired-rooms"],
    ["Actions", "src/actions/chat.ts, rooms.ts, recovery.ts, notifications.ts, media.ts, members.ts, study.ts"],
    ["Room UI", "RoomRealtimeProvider.tsx, RoomChat.tsx, MediaStage.tsx, FilesTab.tsx, StudyStage.tsx, MembersTab.tsx, RoomNotifications.tsx"],
    ["Hooks/libs", "useRoomSync.ts, useRoomPresence.ts, usePrivateChat.ts, encryption.ts, focus-lock.ts, room-lifecycle.ts, storage.ts"],
    ["Database", "supabase/01_schema.sql, POLICIES.md, README.md, migrations 002-005, local .temp metadata"],
    ["Project plan", "OMNILUME_MASTER_PLAN.md and remediation/verification history supplied in the conversation"],
]
story.append(table(["Area", "Primary references"], source_rows, [92, 408]))
story += sub("What must be true before the vision is complete")
story += bullets([
    "A new Google user can create a safe profile and reach the app; an existing user signs in without duplicate identity.",
    "Rooms and Personal Chat are separate, with explicit conversion into one persistent group and no public room username carried into that group.",
    "Relationships, messages, files, features, lifecycle, notifications, and provider connections are server/database authorized.",
    "The complete room experience works for two independent users across Watch, seek, chat, delete, presence, files, study, recovery, permanent conversion, and notifications.",
    "The final tested commit is deployed, live migrations and cron are verified, rollback is understood, and unresolved limitations are shown to users rather than hidden.",
])
story.append(Spacer(1, 8 * mm))
story.append(HRFlowable(width="100%", thickness=1, color=VIOLET, spaceBefore=5, spaceAfter=8))
story.append(P("End of blueprint", "RightSmall"))


doc = RoadmapDocTemplate(str(OUT), pagesize=A4, rightMargin=18 * mm, leftMargin=18 * mm, topMargin=23 * mm, bottomMargin=20 * mm, title="OmniLume - Master Product Roadmap & Implementation Blueprint", author="OmniLume")
doc.build(story)
print(str(OUT))
