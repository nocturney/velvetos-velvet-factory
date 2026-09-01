# VelvetOS — Velvet Factory

פרונט (office frontend) לעסק ההדפסות התלת־ממד.

## התחלה — הכי פשוט

1. שכפל `nocturney/velvetos-core` **או** `nocturney/velvetos-velvet-factory`
2. **Cloud Agent:** `.cursor/environment.json` מריץ `attach-core` אוטומטית — לא צריך ידנית
3. **מקומי:** לחיצה כפולה על **`START-VF.bat`** (Windows) או `./scripts/attach-core.sh`
4. Cursor → Open Folder → התיקייה הזו

מדריך מלא: [`docs/START-HERE-HE.md`](../../docs/START-HERE-HE.md)

---

## ריפo נפרד (אופציונלי — לא חובה עכשיו)

הבאקאנד / הליבה: **VelvetOS Core** (`nocturney/velvetos-core`).

2. מתוך הריפו של הליבה:

```bash
./scripts/publish-instance.sh velvet-factory nocturney/velvetos-velvet-factory
```

3. בתוך הריפו החדש:

```bash
./scripts/attach-core.sh
python3 vendor/velvetos-core/scripts/check-velvetos.py  # after attach, or run core sensors from vendor
```

4. פתח את ריפו המופע ב־Cursor כ־workspace לניהול היומיומי של VF.

## מה נשאר בליבה

כל המודולים, הפקים `vf*`, החוקה, הסנסורים, ה־presets ליופי/פסיכיאטר.

## מה חי כאן

עובדות סטודיו, CTA, IG, בחירת מודולים, שולחן כלי החיים.
