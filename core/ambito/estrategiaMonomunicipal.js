/**
 * core/ambito/estrategiaMonomunicipal.js
 *
 * Estrategia de ámbito MONOMUNICIPAL (ambitoTerritorial ausente o "municipio").
 *
 * ── QUÉ HACE ─────────────────────────────────────────────────────────────
 * El deployment sirve UN municipio y no existe territorio superior. No hay
 * base que preservar: cargar un municipio RECONSTRUYE todo el conjunto de
 * capas y aplica la máscara sobre el propio municipio.
 *
 *   cargaAutomatica() → true si hay exactamente un municipio (producción)
 *   iniciar()         → si carga automática, carga ese municipio
 *   seleccionar(ine)  → reemplaza todas las capas + máscara + zoom
 *   limpiar()         → no-op: no existe "vista territorial" a la que volver
 *
 * ── POR QUÉ limpiar() ES UN NO-OP Y NO ESTÁ AUSENTE ──────────────────────
 * El contrato de las estrategias es único (ver crearEstrategia.js). Así el
 * selector de la UI llama siempre a limpiar() sin preguntar de qué ámbito
 * se trata. Si el método faltara, habría que reintroducir un if por ámbito
 * en la UI, que es justo lo que este patrón elimina.
 *
 * ── DEPENDENCIAS ─────────────────────────────────────────────────────────
 * No importa nada de ui/. La UI llega como callbacks (ui.setLoading) para
 * que core/ no dependa de la capa de presentación.
 */

import * as configEngine   from "../../config/configEngine.js";
import * as mapManager     from "../mapManager.js";
import { construirCapas }  from "./cargaCapas.js";
import { emit }            from "../../utils/eventBus.js";

/**
 * @param {Object}   contexto
 * @param {Object[]} contexto.municipiosDisponibles - Resueltos por territorioResolver
 * @param {{setLoading?: Function}} [contexto.ui]    - Callbacks de la UI
 */
export function crearEstrategiaMonomunicipal({ municipiosDisponibles, ui }) {
  const { setLoading = () => {} } = ui ?? {};

  let cargando        = false;
  let municipioActivo = null;

  async function seleccionar(codigoIne) {
    if (!codigoIne || cargando) return;

    const municipioData = municipiosDisponibles.find(m => m.codigo_ine === codigoIne);
    if (!municipioData) return;

    municipioActivo = codigoIne;

    cargando = true;
    setLoading(true);

    try {
      console.info(`[ámbito monomunicipal] → ${municipioData.nombre} (${municipioData.codigo_ine})`);

      emit("municipio-seleccionado", { municipioData });

      const configs = await configEngine.fetchCapas(municipioData);

      if (configs.length === 0) {
        console.warn(`[ámbito monomunicipal] No hay capas disponibles para "${municipioData.nombre}"`);
        return;
      }

      const { layers, cfgList, lazyLayerIds, capasInmediatas } =
        await construirCapas(configs, municipioData);

      if (layers.length === 0) {
        console.error("[ámbito monomunicipal] Ninguna capa pudo ser creada.");
        return;
      }

      mapManager.addCapas(capasInmediatas);

      await mapManager.actualizarMascara(municipioData.polygon);
      await mapManager.irAlMunicipio(municipioData.bbox);

      emit("municipio-cargado", {
        municipioData,
        layers,
        configs: cfgList,
        lazyLayerIds
      });

      console.info(
        `[ámbito monomunicipal] ✓ ${layers.length} capas cargadas para "${municipioData.nombre}"`
      );

    } catch (err) {
      console.error("[ámbito monomunicipal] Error durante la carga del municipio:", err);
    } finally {
      cargando = false;
      setLoading(false);
    }
  }

  return {
    tipo: "monomunicipal",

    cargaAutomatica() {
      return municipiosDisponibles.length === 1;
    },

    async iniciar() {
      if (this.cargaAutomatica()) {
        await seleccionar(municipiosDisponibles[0].codigo_ine);
      }
    },

    seleccionar,

    async limpiar() {
      // Intencionalmente vacío — ver cabecera del módulo.
    },

    getMunicipioActivo() {
      return municipioActivo;
    }
  };
}