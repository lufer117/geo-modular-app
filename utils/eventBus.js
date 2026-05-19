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
 * EVENTOS DEFINIDOS EN LA APP:
 *   "municipio-seleccionado"  → { municipioData }
 *   "municipio-cargado"       → { municipioData, layers, configs }
 *   "capa-activada"           → { layerId, layer, config }
 *   "capa-desactivada"        → { layerId, layer, config }
 *   "vista-cambiada"          → { modo: "2D" | "3D" }
 *   "basemap-cambiado"        → { basemapId }
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