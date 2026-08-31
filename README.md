# VelvetOS — Velvet Factory

פרונט (office frontend) לעסק ההדפסות התלת־ממד.  
הבאקאנד / הליבה: **VelvetOS Core** (`nocturney/velvet-factory-headquarters-os`).

## מודל

```
VelvetOS Core (backend)          VelvetOS — Velvet Factory (frontend)
laws · modules · packs     →     INSTANCE · STUDIO · desk · tool binds
presets · sensors                modulesEnabled from maker-print
```

## הפעלה אחרי יצירת הריפו ב־GitHub

1. צור ריפו ריק פרטי: `nocturney/velvetos-velvet-factory`
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
