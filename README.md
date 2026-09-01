# VelvetOS — Velvet Factory

פרונט (office frontend) לעסק ההדפסות התלת־ממד.  
הבאקאנד / הליבה: **VelvetOS Core** (`nocturney/velvetos-core`).

שני הריפוז **פומביים** ב-GitHub (2026-09-01).

## מודל

```
VelvetOS Core (backend)          VelvetOS — Velvet Factory (frontend)
laws · modules · packs     →     INSTANCE · STUDIO · desk · tool binds
presets · sensors                modulesEnabled from maker-print
```

## התחלה מהירה

```bash
git clone https://github.com/nocturney/velvetos-velvet-factory.git
cd velvetos-velvet-factory
./scripts/attach-core.sh
python3 vendor/velvetos-core/scripts/check-velvetos.py
```

פתח את התיקייה ב-Cursor. Cloud Agent מריץ `attach-core` אוטומטית דרך `.cursor/environment.json`.

## פרסום מופע חדש (מפתחים)

1. צור ב-GitHub ריפו ריק (פומבי או פרטי): `nocturney/velvetos-<business>`
2. מתוך הליבה:

```bash
PUSH=1 ./scripts/publish-instance.sh <instance-id> nocturney/velvetos-<business>
```

Cloud Agent **לא** יכול `createRepository` — הריפו חייב להיות קיים מראש.

## פערי גישה שנשארו (MCP / OAuth)

ריפו פומבי פותר clone ל-core — **לא** את כל הכלים.

צ'קליסט בעלים (3DAI, Canva, IG Publish, Origin vendor, GitHub PR):

→ אחרי `attach-core`: `vendor/velvetos-core/docs/ACCESS-GAPS.md`

## מה נשאר בליבה

כל המודולים, הפקים `vf*`, החוקה, הסנסורים, ה־presets ליופי/פסיכיאטר.

## מה חי כאן

עובדות סטודיו, CTA, IG, בחירת מודולים, שולחן כלי החיים.
