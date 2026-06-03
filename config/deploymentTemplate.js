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
 *   municipios
 *     Array de codigos_ine que delimitan el ámbito de la instancia.
 *     []    → sin restricción (modo demo: se muestran todos los del catálogo)
 *     ["X"] → un municipio: carga automática al arrancar, sin interacción
 *     ["X","Y",...] → varios: selector activo restringido al ámbito
 *
 *   idiomas
 *     Idiomas disponibles en esta instancia. Depende del territorio del cliente.
 *     Ejemplos:
 *       País Vasco  → ["es", "eu", "en"]
 *       Galicia     → ["es", "gl", "en"]
 *       Nacional    → ["es", "en"]
 *     Pendiente: arquitectura i18n — este campo está reservado para esa fase.
 *
 *   idioma_defecto
 *     Idioma activo al arrancar. Debe estar incluido en el array idiomas.
 */

// ── MODO DEMO / TFM ───────────────────────────────────────────────────────
// Todos los municipios del catálogo disponibles. Para desarrollo y reuniones.
export const DEPLOYMENT = {
  mode:           "demo",
  cliente:        "tfm-demo",
  municipios:     [],
  idiomas:        ["es"],
  idioma_defecto: "es"
};

// ── MODO AYUNTAMIENTO (1 municipio) ───────────────────────────────────────
// La app arranca y carga el municipio automáticamente sin interacción.
// Descomentar y ajustar el codigo_ine al municipio del cliente.
//
// export const DEPLOYMENT = {
//   mode:           "production",
//   cliente:        "ayuntamiento-pamplona",
//   municipios:     ["31201"],
//   idiomas:        ["es", "eu", "en"],
//   idioma_defecto: "es"
// };

// ── MODO COMARCA / MANCOMUNIDAD (N municipios) ────────────────────────────
// Selector activo restringido al ámbito del cliente.
// Descomentar y ajustar los codigos_ine al ámbito del cliente.
//
// export const DEPLOYMENT = {
//   mode:           "production",
//   cliente:        "comarca-pamplona",
//   municipios:     ["31201", "31002", "31003"],
//   idiomas:        ["es", "eu", "en"],
//   idioma_defecto: "es"
// };