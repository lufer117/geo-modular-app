// layers.js
// ============================================================
// SISTEMA DE CONFIGURACIÓN
// En el futuro estos datos vendrán de un JSON externo o BD.
// La estructura de cada objeto NO cambiará cuando eso ocurra.
// ============================================================

export const CAPAS_CONFIG = [
  {
    id: "catastro",
    title: "Catastro",
    description: "",          // ← vacío ahora, se rellena cuando llegue la BD
    tipo: "WMS",
    url: "https://ovc.catastro.meh.es/cartografia/INSPIRE/spadgcwms.aspx",
    sublayers: [{ name: "CP.CadastralParcel" }],
    legendEnabled: true,
    visible: false // para que sea el usuario el que la active
  },
  {
    id: "pnoa",
    title: "Ortofoto PNOA (IGN)",
    description: "",          // ← vacío ahora, se rellena cuando llegue la BD
    tipo: "WMS",
    url: "https://www.ign.es/wms-inspire/pnoa-ma",
    sublayers: [{ name: "OI.OrthoimageCoverage" }],
    legendEnabled: true,
    visible: false // usuario activa la capa
  },
  {
    id: "unidades-administrativas",
    title: "Unidades administrativas de España",
    description: "",          // ← vacío ahora, se rellena cuando llegue la BD
    tipo: "WMS",
    url: "https://www.ign.es/wms-inspire/unidades-administrativas",
    sublayers: [{ name: "AU.AdministrativeUnit" }],
    legendEnabled: true,
    visible: false
  }
];