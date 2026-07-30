/**
 * config/adapters/LocalJsonAdapter.js
 *
 * Adaptador concreto que lee cualquier dataset JSON local (catálogo de
 * capas, municipios, provincias, CCAA...) siguiendo el patrón Repository.
 *
 * ── PATRÓN REPOSITORY ────────────────────────────────────────────────────
 * Implementa una interfaz genérica que cualquier consumidor puede usar
 * sin conocer el origen del dato:
 *   getData() → Promise<Array>
 *
 * El consumidor (configEngine, territorioResolver, etc.) sabe QUÉ necesita.
 * Este adaptador sabe CÓMO obtenerlo (fetch de archivo local).
 * Esa separación es la clave del patrón.
 *
 * ── GENERALIZACIÓN (esta versión) ───────────────────────────────────────
 * Hasta ahora esta clase solo se usaba para el catálogo de capas, y el
 * método público se llamaba getCatalogo() — nombre acoplado a ese caso
 * de uso concreto, aunque la implementación ya era genérica (recibe
 * cualquier URL de JSON en el constructor).
 *
 * Al reutilizar la misma clase para datasets de otro dominio (municipios,
 * provincias, ccaa — ver config/territorioResolver.js), "getCatalogo()"
 * deja de tener sentido semántico: no tiene sentido pedir el "catálogo"
 * de una lista de municipios. Se renombra a getData(), genérico.
 *
 * Verificado el alcance real antes de renombrar (no se dejó alias):
 * getCatalogo() solo se llamaba desde config/configEngine.js, en 2 líneas.
 * Ambos usos se actualizan a getData() en el mismo cambio — ver ese archivo.
 *
 * ── EVOLUCIÓN PREVISTA ───────────────────────────────────────────────────
 *   LocalJsonAdapter  → lee JSON local                        (activo ahora)
 *   RestApiAdapter    → llama a API REST propia                (medio plazo)
 *   PostGISAdapter    → consulta espacial real con bbox        (futuro)
 *
 * Cambiar de adaptador = cambiar UNA línea donde se instancie (main.js,
 * territorioResolver.js...), sin tocar el consumidor:
 *   setAdaptador(new RestApiAdapter("https://api.example.com/capas"));
 *
 * ── CACHE ────────────────────────────────────────────────────────────────
 * El dataset se cachea en memoria tras el primer fetch. Si el consumidor
 * pide el dato varias veces (p. ej. varios cambios de municipio), no hay
 * múltiples peticiones. Útil aunque el JSON sea local (evita parsear
 * JSON repetidamente).
 */

export class LocalJsonAdapter {
  /**
   * @param {string} dataUrl - Ruta relativa o absoluta al JSON a leer
   */
  constructor(dataUrl) {
    this._dataUrl = dataUrl;
    this._cache = null;  // null = no cargado todavía
  }

  /**
   * Devuelve el array completo del dataset apuntado en el constructor.
   * Primera llamada: fetch + parse. Siguientes: desde cache en memoria.
   * @returns {Promise<Array>}
   */
  async getData() {
    if (this._cache !== null) {
      return this._cache;
    }

    try {
      const response = await fetch(this._dataUrl);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} — ${this._dataUrl}`);
      }

      this._cache = await response.json();

      console.info(
        `[LocalJsonAdapter] Dataset cargado: ${this._cache.length} elementos desde "${this._dataUrl}"`
      );

      return this._cache;

    } catch (err) {
      console.error("[LocalJsonAdapter] Error al cargar el dataset:", err);
      // Re-lanzar para que el consumidor (configEngine, territorioResolver...) pueda manejarlo
      throw err;
    }
  }

  /**
   * Invalida la cache forzando un nuevo fetch en la siguiente llamada.
   * Útil en desarrollo para recargar el dataset tras editarlo.
   */
  invalidarCache() {
    this._cache = null;
    console.info("[LocalJsonAdapter] Cache invalidada.");
  }
}