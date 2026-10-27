/**
 * core/ambito/crearEstrategia.js
 *
 * Fábrica de estrategias de ámbito (patrón Strategy). Único punto de la app
 * que decide QUÉ HACER según el tipo de ámbito; la decisión de QUÉ TIPO ES
 * el deployment vive en config/tipoAmbito.js.
 *
 * ── CONTRATO DE UNA ESTRATEGIA ───────────────────────────────────────────
 * Toda estrategia devuelve un objeto con:
 *
 *   tipo: string
 *     "monomunicipal" | "supramunicipal".
 *
 *   cargaAutomatica(): boolean
 *     true si la app debe cargar sola, sin que el usuario elija y sin
 *     mostrar selector (un único municipio en producción).
 *
 *   iniciar(): Promise<void>
 *     Carga inicial. Se llama UNA vez desde main.js, DESPUÉS de montar la
 *     UI y registrar todos los listeners del eventBus (que no guarda
 *     eventos: uno emitido sin oyentes se pierde).
 *
 *   seleccionar(codigoIne): Promise<void>
 *     El usuario eligió un municipio.
 *
 *   limpiar(): Promise<void>
 *     El usuario limpió la selección.
 *
 *   getMunicipioActivo(): string|null
 *     codigo_ine del municipio en foco, o null.
 *
 * ── EVENTOS QUE EMITEN (sin cambios respecto a antes del refactor) ───────
 *   municipio-seleccionado  { municipioData }
 *   municipio-cargado       { municipioData, layers, configs, lazyLayerIds }   (monomunicipal)
 *   territorio-cargado      { territorioData, layers, configs, lazyLayerIds }  (supramunicipal)
 *   capas-municipio-agregadas { municipioData, layers, configs, lazyLayerIds } (supramunicipal)
 *   capas-municipio-retiradas { layerIds }                                     (supramunicipal)
 *
 * ── CONTEXTO QUE RECIBE LA FÁBRICA ───────────────────────────────────────
 *   municipiosDisponibles: Object[]  (de territorioResolver)
 *   mascaraInicial: Object|null      (de territorioResolver)
 *   ui: { setLoading(bool), limpiarSeleccion() }  callbacks de la UI, para
 *      que core/ no importe de ui/.
 *
 * ── CÓMO AÑADIR UN ÁMBITO NUEVO (ej. comarca) ────────────────────────────
 * Si se comporta como un territorio con base + municipios superpuestos, no
 * hace falta estrategia nueva: tipoAmbito.js ya lo clasifica como
 * supramunicipal y solo falta su caso en territorioResolver. Una estrategia
 * nueva solo se justifica si el comportamiento es distinto: se añade su
 * fichero y UNA línea en ESTRATEGIAS.
 */

import { resolverTipoAmbito, TIPO_AMBITO } from "../../config/tipoAmbito.js";
import { crearEstrategiaMonomunicipal }    from "./estrategiaMonomunicipal.js";
import { crearEstrategiaSupramunicipal }   from "./estrategiaSupramunicipal.js";

const ESTRATEGIAS = {
  [TIPO_AMBITO.MONOMUNICIPAL]:  crearEstrategiaMonomunicipal,
  [TIPO_AMBITO.SUPRAMUNICIPAL]: crearEstrategiaSupramunicipal,
};

/**
 * @param {Object} deployment - DEPLOYMENT de config/deployment.js
 * @param {Object} contexto   - { municipiosDisponibles, mascaraInicial, ui }
 * @returns {Object} Estrategia con el contrato descrito arriba
 * @throws {Error} si ambitoTerritorial no se reconoce (lo lanza tipoAmbito.js)
 */
export function crearEstrategia(deployment, contexto) {
  const tipo = resolverTipoAmbito(deployment);
  return ESTRATEGIAS[tipo](contexto);
}