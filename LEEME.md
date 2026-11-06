# 🐷 Chanchito — gastos en familia

App web instalable (PWA) para anotar los gastos e ingresos de la casa entre todos.

**Qué hace**
- Gastos e ingresos por categoría, con quién pagó y el medio de pago.
- Resumen del mes: cuánto entró, cuánto salió, cuánto queda, en qué se fue la plata y la comparación con el mes anterior.
- Presupuestos: un tope mensual por categoría, con aviso al llegar al 80% y al pasarse.
- Gastos fijos (alquiler, servicios, colegio…) y compras en cuotas: se cargan solos cada mes.
- Lectura de comprobantes con la cámara (gratis, dentro del celular): completa monto, fecha, comercio, medio de pago y categoría; la foto queda adjunta al gasto.
- Resumen del mes para mandar por WhatsApp (botón en Inicio): totales, categorías, presupuestos, fijos, cuotas y quién pagó.
- Exportación a Excel (CSV) del mes o de todo.
- Modo oscuro automático. Funciona sin señal.

## Probarla en la compu

Hacé clic derecho en `servidor.ps1` → *Ejecutar con PowerShell*, y abrí http://localhost:8080.

Mientras `firebase-config.js` tenga `null`, la app funciona en **modo "En este equipo"**: los datos quedan solo en ese navegador. Desde Ajustes podés hacer una copia de seguridad.

## Activar la nube para usarla en familia (una sola vez, ~15 minutos, gratis)

1. **Crear el proyecto**: entrá a https://console.firebase.google.com → *Agregar proyecto* → nombre `chanchito` (Google Analytics no hace falta).
2. **Login con Google**: *Compilación → Authentication → Comenzar → Google → Habilitar*. Elegí tu mail como correo de asistencia y guardá.
3. **Base de datos**: *Compilación → Firestore Database → Crear base de datos* → ubicación `southamerica-east1 (São Paulo)` → *modo de producción*.
4. **Reglas de seguridad**: en Firestore, pestaña *Reglas*: borrá lo que hay, pegá el contenido de `firestore.rules` y tocá *Publicar*. Así cada familia solo ve lo suyo.
5. **Registrar la app web**: *Configuración del proyecto (⚙️) → Tus apps → `</>` Web* → nombre `chanchito`. Copiá el objeto `firebaseConfig` que te muestra y pegalo en `firebase-config.js`, reemplazando el `null`.
6. **Publicarla** (necesita https para instalarse en el celular). Lo más simple, como hiciste con Disidentes:
   - Creá un repo en GitHub (por ejemplo `chanchito`) y subí todos los archivos de esta carpeta, menos `servidor.ps1` y la carpeta `.claude`.
   - En el repo: *Settings → Pages → Deploy from a branch → main / root*.
   - Te queda en `https://TU-USUARIO.github.io/chanchito/`.
7. **Autorizar el dominio**: en Firebase, *Authentication → Configuración → Dominios autorizados → Agregar dominio* → `TU-USUARIO.github.io`.

> La configuración de Firebase no es secreta (va en todas las apps web); lo que protege los datos son las reglas del paso 4.

## Sumar a la familia

1. Abrí la app, entrá con Google y creá el grupo ("Casa de los …").
2. En **Ajustes → Familia** tocá **Compartir link** y mandalo por WhatsApp.
3. Cada uno lo abre, entra con su cuenta de Google y queda adentro. Todos ven y cargan lo mismo, en tiempo real.

## Instalarla en el celular

- **Android (Chrome)**: menú ⋮ → *Agregar a la pantalla principal / Instalar app*.
- **iPhone (Safari)**: botón compartir → *Agregar a inicio*.

## Cómo se usa

- **+** para cargar. Si elegís *Crédito*, te pregunta en cuántas cuotas: ponés el total y la app reparte las cuotas mes a mes.
- **Fijos**: cargás el alquiler o la prepaga una vez y aparece solo todos los meses, el día que indiques. Si lo pausás y lo reactivás, no rellena los meses en pausa.
- **Ajustes → Categorías**: cambiá nombres, íconos y colores, y poné el tope mensual de cada una.

## Archivos

| Archivo | Para qué |
|---|---|
| `index.html`, `styles.css`, `app.js` | La app (pantallas, estilos y lógica) |
| `store-local.js` | Guardado en el dispositivo |
| `store-cloud.js` | Sincronización con Firebase |
| `firebase-config.js` | Tus claves de Firebase (vacío = modo local) |
| `firestore.rules` | Reglas de seguridad para pegar en Firebase |
| `manifest.json`, `sw.js`, `icons/` | Instalación en el celular y uso sin señal |
| `servidor.ps1` | Servidor para probarla en la compu |

Si después de publicar un cambio seguís viendo la versión vieja, cerrá la app y volvé a abrirla. Siempre busca primero la versión nueva.
