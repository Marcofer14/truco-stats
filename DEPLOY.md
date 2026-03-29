# Guía de deploy — Truco Stats

## Paso 1 — Subir el código a GitHub

1. Creá una cuenta en https://github.com si no tenés
2. Creá un repositorio nuevo (ej: `truco-stats`), que sea **privado**
3. Descargá e instalá GitHub Desktop: https://desktop.github.com
4. En GitHub Desktop: File → Add local repository → seleccioná la carpeta `truco-app`
5. Hacé commit de todos los archivos y luego "Publish repository"

---

## Paso 2 — Crear la base de datos en MongoDB Atlas (gratis)

1. Entrá a https://cloud.mongodb.com y creá una cuenta
2. Creá un **nuevo proyecto** (ej: `truco`)
3. Creá un **cluster gratis** (M0 Free Tier)
4. En "Database Access": creá un usuario con contraseña fuerte — guardá las credenciales
5. En "Network Access": Add IP Address → **Allow access from anywhere** (0.0.0.0/0)
6. En el cluster, hacé clic en **Connect** → Drivers → copiá el string de conexión:
   ```
   mongodb+srv://<usuario>:<password>@cluster0.xxxxx.mongodb.net/truco_db
   ```
7. Reemplazá `<usuario>` y `<password>` con los datos del paso 4

---

## Paso 3 — Migrar la data existente a Atlas

Con Compass ya tenés la data en tu MongoDB local. Para copiarla a Atlas:

1. Abrí Compass
2. Conectate a tu MongoDB local (`localhost:27017`)
3. Entrá a cada colección (jugadores, torneos, partidos, elo_historial)
4. Hacé clic en **Export** → exportar como JSON
5. Conectate a Atlas con el string del paso anterior
6. En cada colección en Atlas: **Import** → subí el JSON exportado

---

## Paso 4 — Deploy en Render (gratis, siempre online)

1. Creá cuenta en https://render.com
2. Hacé clic en **New** → **Web Service**
3. Conectá tu cuenta de GitHub y seleccioná el repo `truco-stats`
4. Configurá el servicio:
   - **Name**: truco-stats
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. En **Environment Variables**, agregá:
   ```
   MONGO_URI     = (el string de conexión de Atlas del paso 2)
   ADMIN_PASSWORD = (tu contraseña secreta para el panel admin)
   ```
6. Hacé clic en **Create Web Service**

Render va a buildear y deploear automáticamente. En ~2 minutos tenés la URL:
```
https://truco-stats.onrender.com
```

---

## Resultado final

| URL | Qué hace |
|-----|----------|
| `tuapp.onrender.com` | Stats públicas (ELO, win rate, etc.) |
| `tuapp.onrender.com/cargar.html` | Formulario para que tus amigos carguen torneos |
| `tuapp.onrender.com/admin.html` | Tu panel privado para aprobar/rechazar |

---

## Nota sobre el plan gratuito de Render

El plan gratuito "duerme" la app después de 15 minutos sin visitas.
La primera visita tarda ~30 segundos en despertar. Esto es normal y no afecta la data.
Si querés que esté siempre activa, el plan Starter cuesta USD 7/mes.
