/**
 * config/deployment.example.js
 *
 * Plantilla de configuración de instancia.
 *
 * ── INSTRUCCIONES ────────────────────────────────────────────────────────
 * 1. Copia este archivo como config/deployment.js
 * 2. Edita los valores según el cliente o el entorno
 * 3. Nunca subas deployment.js a git (está en .gitignore)
 *
 * ── CAMPOS ───────────────────────────────────────────────────────────────
 *
 *   mode
 *     "demo"       → todos los municipios disponibles (TFM / reuniones)
 *     "production" → instancia real para un cliente concreto
 *
 *   cliente
 *     Identificador libre. Solo para trazabilidad interna.
 *     No afecta al comportamiento de la app.
 *
 *   nombre_visible
 *     Nombre del cliente que aparece en la UI (cabecera, accesibilidad).
 *
 *   municipios
 *     Array de codigos_ine que delimitan el ámbito de la instancia.
 *     []          → sin restricción (modo demo: todos los del catálogo)
 *     ["X"]       → un municipio: carga automática al arrancar, sin interacción
 *     ["X","Y",...] → varios: selector activo restringido al ámbito
 *
 *   idiomas
 *     Idiomas disponibles en esta instancia. Depende del territorio del cliente.
 *     Ejemplos:
 *       País Vasco  → ["eu", "es", "en"]   (euskera primero = idioma del territorio)
 *       Galicia     → ["gl", "es", "en"]
 *       Nacional    → ["es", "en"]
 *     El primer idioma del array es el idioma_defecto si no se especifica otro.
 *
 *   idioma_defecto
 *     Idioma activo al arrancar. Debe estar incluido en el array idiomas.
 *
 *   branding.logo_cliente
 *     Ruta relativa desde app/ o URL absoluta al logo del cliente.
 *     null → se muestra el icono SVG por defecto (icon="map-pin").
 *
 *   branding.logo_empresa
 *     Logo de la empresa integradora. Siempre visible.
 *
 * ── RESOLUCIÓN EN DESARROLLO ─────────────────────────────────────────────
 * deployment.js lee ?cliente= de la URL para simular distintas instancias
 * sin cambiar el archivo. Clientes disponibles en el script:
 *
 *   ?cliente=pamplona  → 1 municipio, es/eu/en, idioma_defecto es
 *   ?cliente=bilbao    → 1 municipio, eu/es/en, idioma_defecto eu
 *   ?cliente=bizkaia   → 3 municipios País Vasco
 *   ?cliente=navarra   → 3 municipios Navarra
 *   ?cliente=demo      → todos los municipios (sin restricción)
 *   (sin parámetro)    → fallback a "demo"
 *
 * En producción el archivo exporta directamente un único DEPLOYMENT
 * sin leer la URL — el cliente ya está configurado en el despliegue.
 * ─────────────────────────────────────────────────────────────────────────
 */


// ── MODO DEMO / TFM ───────────────────────────────────────────────────────
// Todos los municipios del catálogo disponibles. Para desarrollo y reuniones.

export const DEPLOYMENT = {
  mode:           "demo",
  cliente:        "tfm-demo",
  nombre_visible: "Demo TFM — Visor GIS Municipal",
  municipios:     [],
  idiomas:        ["es", "eu", "en"],
  idioma_defecto: "es",
  branding: {
    logo_cliente:  null,
    logo_empresa:  "../assets/logos/bilbomatica.svg",
  }
};


// ── MODO AYUNTAMIENTO (1 municipio) ───────────────────────────────────────
// La app arranca y carga el municipio automáticamente sin interacción.
// Descomentar y ajustar codigo_ine, idiomas y branding al cliente.

/*
export const DEPLOYMENT = {
  mode:           "production",
  cliente:        "ayuntamiento-pamplona",
  nombre_visible: "Ayuntamiento de Pamplona / Iruñako Udala",
  municipios:     ["31201"],
  idiomas:        ["es", "eu", "en"],
  idioma_defecto: "es",
  branding: {
    logo_cliente:  "../assets/logos/pamplona.svg",
    logo_empresa:  "../assets/logos/bilbomatica.svg",
  }
};
*/


// ── MODO COMARCA / MANCOMUNIDAD (N municipios) ────────────────────────────
// Selector activo restringido al ámbito del cliente.
// Descomentar y ajustar codigos_ine, idiomas y branding al cliente.

/*
export const DEPLOYMENT = {
  mode:           "production",
  cliente:        "gobierno-navarra",
  nombre_visible: "Gobierno de Navarra / Nafarroako Gobernua",
  municipios:     ["31201", "31232", "31084"],
  idiomas:        ["es", "eu", "en"],
  idioma_defecto: "es",
  branding: {
    logo_cliente:  "../assets/logos/navarra.svg",
    logo_empresa:  "../assets/logos/bilbomatica.svg",
  }
};
*/