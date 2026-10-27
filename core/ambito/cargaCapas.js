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
 * No anade nada al mapa, no emite eventos, no hace zoom ni mascara, no toca
 * el DOM. Esas decisiones SI dependen del ambito (reemplazar vs. sumar,
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
 *   capasInmediatas: Layer[]
 * }>}
 *   layers y cfgList son paralelos (mismo indice). lazyLayerIds contiene los
 *   ids de las capas WFS, que NO se anaden al mapa de inmediato (carga
 *   diferida desde layerTree). capasInmediatas es el subconjunto de layers
 *   que si debe anadirse al mapa ya.
 */
export async function construirCapas(configs, territorioData) {
  const layersConNull = await Promise.all(
    configs.map(config => crearCapa(config))
  );

  const pares = configs
    .map((config, i) => ({ config, layer: layersConNull[i] }))
    .filter(({ layer }) => layer !== null);

  await Promise.all(
    pares.map(({ layer, config }) => inicializarCapa(layer, config, territorioData))
  );

  const layers  = pares.map(p => p.layer);
  const cfgList = pares.map(p => p.config);

  const lazyLayerIds = new Set(
    cfgList.filter(c => c.tipo === "WFS").map(c => c.id)
  );

  const capasInmediatas = layers.filter((_, i) => cfgList[i].tipo !== "WFS");

  return { layers, cfgList, lazyLayerIds, capasInmediatas };
}