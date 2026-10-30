/**
 * core/ambito/cargaCapas.js
 *
 * Pipeline compartido de CONSTRUCCION de capas a partir de configs del catalogo.
 *
 * ── RESPONSABILIDAD ──────────────────────────────────────────────────────
 *   configs -> crearCapa -> descartar nulos -> inicializarCapa -> separar WFS lazy
 *
 * Es la parte que municipioSelector tenia copiada tres veces (carga
 * monomunicipal, base territorial supramunicipal y capas municipales
 * incrementales). Centralizarla cumple DRY: un arreglo en el pipeline se
 * hace una sola vez y las tres rutas lo heredan.
 *
 * ── LO QUE NO HACE (a proposito) ─────────────────────────────────────────
 * No anade nada al mapa, no emite eventos de carga de ambito, no hace zoom ni
 * mascara, no toca el DOM (unica excepcion: notificarFallosDeCarga(), que la
 * llama cada estrategia tras emitir su evento de carga). Esas decisiones SI dependen del ambito (reemplazar vs. sumar,
 * mascara vs. resaltado) y son responsabilidad de cada estrategia de ambito.
 * Este modulo solo responde: "dadas estas configs y este territorio, dame
 * las capas listas".
 *
 * ── AGNOSTICO A LA ESCALA ────────────────────────────────────────────────
 * territorioData puede ser un municipio, una provincia o una CCAA: igual que
 * layerInitializer, solo lee los campos que necesita (bbox, codigo_ine,
 * provincia_code, ccaa_code). El nombre del parametro lo refleja.
 */

import { crearCapa }       from "../layerFactory.js";
import { inicializarCapa } from "../layerInitializer.js";
import { emit }            from "../../utils/eventBus.js";

/**
 * Una capa "diferida" no entra al mapa en la carga inicial: se anade cuando el
 * usuario la activa. Son las WFS (discovery lazy) y las marcadas con
 * servicio_disponible:false en el catalogo. Esa marca es una foto fija del
 * ultimo enriquecimiento y puede estar caducada, asi que no se usa para
 * bloquear la capa, pero tampoco se carga sin que nadie la pida: evita errores
 * de servicios caidos en cada arranque. Si el servicio ya se recupero, funcionara
 * al activarla; si no, layerTree la marca como fallida y permite reintentar.
 */
export function esCapaDiferida(config) {
  return config.tipo === "WFS" || config.servicio_disponible === false;
}

/**
 * Construye e inicializa las capas de una lista de configs.
 *
 * Tolerancia a fallos: crearCapa() ya devuelve null (y registra el error)
 * si una capa concreta falla; aqui esas capas se descartan para que un
 * servicio caido no tumbe al resto.
 *
 * @param {Object[]} configs        - Entradas del catalogo (fetchCapas*)
 * @param {Object}   territorioData - Territorio activo (municipio, provincia o ccaa)
 * @returns {Promise<{
 *   layers: Layer[],
 *   cfgList: Object[],
 *   lazyLayerIds: Set<string>,
 *   capasInmediatas: Layer[],
 *   fallidas: Map<string, Error>
 * }>}
 *   layers y cfgList son paralelos (mismo indice). lazyLayerIds contiene los
 *   ids de las capas WFS, que NO se anaden al mapa de inmediato (carga
 *   diferida desde layerTree). capasInmediatas es el subconjunto de layers
 *   que si debe anadirse al mapa ya. fallidas contiene las capas cuya
 *   inicializacion fallo (id -> error, p. ej. timeout de layer.load() en una
 *   capa FILTRABLE): NO estan en capasInmediatas y las estrategias deben
 *   excluirlas tambien al anadir capas una a una.
 */
export async function construirCapas(configs, territorioData) {
  const layersConNull = await Promise.all(
    configs.map(config => crearCapa(config))
  );

  const pares = configs
    .map((config, i) => ({ config, layer: layersConNull[i] }))
    .filter(({ layer }) => layer !== null);

  const resultados = await Promise.all(
    pares.map(({ layer, config }) => inicializarCapa(layer, config, territorioData))
  );

  // Capa sin su filtro = datos de fuera del ambito: no se muestra. Se queda en
  // layers/cfgList (los indices del arbol dependen de ello) pero fuera del mapa.
  const fallidas = new Map();
  resultados.forEach((r, i) => {
    if (r?.ok === false) fallidas.set(pares[i].config.id, r.error);
  });

  const layers  = pares.map(p => p.layer);
  const cfgList = pares.map(p => p.config);

  const lazyLayerIds = new Set(
    cfgList.filter(c => c.tipo === "WFS").map(c => c.id)
  );

  const capasInmediatas = layers.filter(
    (_, i) => !esCapaDiferida(cfgList[i]) && !fallidas.has(cfgList[i].id)
  );

  return { layers, cfgList, lazyLayerIds, capasInmediatas, fallidas };
}

/**
 * Informa de las capas que no pudieron inicializarse reutilizando el evento de
 * la pieza 4 ("capa-error-carga"): layerTree las marca con el icono de fallo y
 * permite reintentar sin recargar. Se llama DESPUES de emitir el evento de
 * carga del ambito, para que los nodos ya existan en el arbol.
 *
 * @param {Map<string, Error>} fallidas - id de capa -> error (de construirCapas)
 */
export function notificarFallosDeCarga(fallidas) {
  fallidas.forEach((error, layerId) => {
    console.warn(`[cargaCapas] Capa fuera del mapa (inicializacion fallida): "${layerId}"`);
    emit("capa-error-carga", { layerId, vista: "2D", error });
  });
}