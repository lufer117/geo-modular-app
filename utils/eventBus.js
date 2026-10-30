/**
 * utils/eventBus.js
 *
 * Bus de eventos desacoplado para comunicación entre módulos.
 * Implementa Publish/Subscribe (pub/sub) sin dependencias externas.
 *
 * PRINCIPIO SRP: único responsable de la comunicación inter-módulos.
 * Los módulos no se importan entre sí directamente para notificarse;
 * solo hablan a través de este bus. Esto permite añadir o retirar
 * módulos sin modificar los existentes (Open/Closed Principle).
 *
 * CONTRATO DEL BUS:
 *    - on(evento, cb): suscribe la función cb (callback: la acción que se
 *     ejecutará cuando ocurra el evento) a un evento. Devuelve a su vez una
 *     función que, al llamarla, cancela esa suscripción.
 *    - off(evento, cb): cancela la suscripción de cb a ese evento; desde ese
 *     momento deja de recibir avisos. Hay que pasarle la misma función que se
 *     usó en on(), porque así es como el bus sabe cuál retirar.
 *   - emit(evento, datos): avisa a todos los suscritos a ese evento, en ese
 *     mismo momento y uno tras otro. Si uno falla, se registra el error en
 *     consola y los demás reciben el aviso igualmente.
 *   - Cada módulo escucha eventos por su nombre exacto. No existe "escuchar
 *     una sola vez" ni "escuchar todos los eventos de un grupo". Ejemplos:
 *       · layerTree quiere enterarse de "capas-municipio-agregadas" y de
 *         "capas-municipio-retiradas": se suscribe a cada uno por separado;
 *         no puede pedir "todo lo que empiece por capas-municipio-".
 *       · Un módulo suscrito a "idioma-cambiado" recibe todos los cambios de
 *         idioma, no solo el primero; para dejar de recibirlos tiene que
 *         cancelar la suscripción con off().
 * 
 *
 * CATÁLOGO DE EVENTOS (fuente única; actualizar aquí al añadir o cambiar uno):
 * 
 * (Payload = los datos que acompañan al evento, p. ej. en "vista-cambiada"
 *  el modo al que se cambió: { modo: "3D" }.)
 *
 *   Evento                      Emisor                       Payload
 *   ──────────────────────────  ───────────────────────────  ─────────────────────────────────────────
 *   "idioma-cambiado"           i18nManager                  { lang }
 *   "vista-cambiada"            mapManager                   { modo: "2D" | "3D" }
 *   "municipio-seleccionado"    estrategia (ambas)           { municipioData }
 *   "municipio-cargado"         estrategiaMonomunicipal      { municipioData, layers, configs, lazyLayerIds }
 *   "territorio-cargado"        estrategiaSupramunicipal     { territorioData, layers, configs, lazyLayerIds }
 *   "capas-municipio-agregadas" estrategiaSupramunicipal     { municipioData, layers, configs, lazyLayerIds }
 *   "capas-municipio-retiradas" estrategiaSupramunicipal     { layerIds }
 *   "capa-activada"             layerTree                    { layerId, layer, config }
 *   "capa-desactivada"          layerTree                    { layerId, layer, config }
 *   "basemap-cambiado"          basemapSelector              { basemapId }
 *   "capa-error-carga"          mapManager                   { layerId, vista: "2D" | "3D", error }
 *
  * 
 * 
 * SIMETRÍA POR ÁMBITO: la estrategia monomunicipal emite "municipio-cargado";
 * la supramunicipal emite "territorio-cargado" (carga base) y luego
 * "capas-municipio-agregadas/retiradas" (carga incremental por municipio).
 *
 * SIN CONSUMIDORES 28.10.26: "municipio-seleccionado", "capa-activada",
 * "capa-desactivada" y "basemap-cambiado" se emiten pero ningún módulo los
 * escucha todavía. Se mantienen como puntos de extensión (p. ej. leyenda,
 * analítica) sin coste: emit() sobre un evento sin listeners no hace nada.
 */

const _listeners = new Map();

/**
 * Suscribe un callback a un evento.
 * @param {string} evento
 * @param {Function} callback
 * @returns {Function} función de cancelación (unsubscribe)
 */
export function on(evento, callback) {
  if (!_listeners.has(evento)) {
    _listeners.set(evento, new Set());
  }
  _listeners.get(evento).add(callback);
  // Devolver función de limpieza previene memory leaks en módulos que se destruyen
  return () => off(evento, callback);
}

/**
 * Cancela la suscripción de un callback.
 * @param {string} evento
 * @param {Function} callback
 */
export function off(evento, callback) {
  _listeners.get(evento)?.delete(callback);
}

/**
 * Emite un evento con datos opcionales.
 * Los errores en callbacks son capturados individualmente para que
 * un handler roto no impida que el resto reciban el evento.
 * @param {string} evento
 * @param {*} datos
 */
export function emit(evento, datos) {
  _listeners.get(evento)?.forEach(cb => {
    try {
      cb(datos);
    } catch (err) {
      console.error(`[eventBus] Error en handler de "${evento}":`, err);
    }
  });
}