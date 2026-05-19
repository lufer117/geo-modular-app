/**
 * config/adapters/LocalJsonAdapter.js
 *
 * Adaptador concreto que lee el catálogo de capas desde un JSON local.
 *
 * ── PATRÓN REPOSITORY ────────────────────────────────────────────────────
 * Implementa la interfaz que configEngine espera de cualquier adaptador:
 *   getCatalogo() → Promise<Capa[]>
 *
 * configEngine sabe QUÉ necesita (el catálogo completo).
 * Este adaptador sabe CÓMO obtenerlo (fetch de archivo local).
 * Esa separación es la clave del patrón.
 *
 * ── EVOLUCIÓN PREVISTA ───────────────────────────────────────────────────
 *   LocalJsonAdapter  → lee catalogo-capas.json local        (activo ahora)
 *   RestApiAdapter    → llama a API REST propia               (medio plazo)
 *   PostGISAdapter    → consulta espacial real con bbox       (futuro)
 *
 * Cambiar de adaptador = cambiar UNA línea en main.js:
 *   setAdaptador(new RestApiAdapter("https://api.example.com/capas"));
 * Nada más cambia en toda la aplicación.
 *
 * ── CACHE ────────────────────────────────────────────────────────────────
 * El catálogo se cachea en memoria tras el primer fetch.
 * Si el usuario cambia de municipio varias veces, no hay múltiples peticiones.
 * Útil aunque el JSON sea local (evita parsear JSON repetidamente).
 */

export class LocalJsonAdapter {
  /**
   * @param {string} catalogoUrl - Ruta relativa o absoluta al JSON del catálogo
   */
  constructor(catalogoUrl) {
    this._catalogoUrl = catalogoUrl;
    this._cache = null;  // null = no cargado todavía
  }

  /**
   * Devuelve el array completo de capas del catálogo.
   * Primera llamada: fetch + parse. Siguientes: desde cache en memoria.
   * @returns {Promise<Capa[]>}
   */
  async getCatalogo() {
    if (this._cache !== null) {
      return this._cache;
    }

    try {
      const response = await fetch(this._catalogoUrl);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} — ${this._catalogoUrl}`);
      }

      this._cache = await response.json();

      console.info(
        `[LocalJsonAdapter] Catálogo cargado: ${this._cache.length} capas desde "${this._catalogoUrl}"`
      );

      return this._cache;

    } catch (err) {
      console.error("[LocalJsonAdapter] Error al cargar el catálogo:", err);
      // Re-lanzar para que configEngine (y municipioSelector) puedan manejarlo
      throw err;
    }
  }

  /**
   * Invalida la cache forzando un nuevo fetch en la siguiente llamada.
   * Útil en desarrollo para recargar el catálogo tras editarlo.
   */
  invalidarCache() {
    this._cache = null;
    console.info("[LocalJsonAdapter] Cache invalidada.");
  }
}