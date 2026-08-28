"""
migrar-catalogo.py

Script de transformación: Excel (.xlsx) o CSV → catalogo-capas-ne.json

USO:
    Opción A — desde Excel directamente (recomendado):
        python migrar-catalogo.py capas.xlsx

    Opción B — desde CSV exportado:
        python migrar-catalogo.py capas.csv

    El archivo catalogo-capas-ne.json se genera en la misma carpeta.

REQUISITOS:
    pip install openpyxl pandas

COLUMNAS ESPERADAS EN EL EXCEL/CSV:
    bloque_tematico, subtema, nombre_capa, proveedor, tipo_acceso,
    url_endpoint, cobertura_geografica, cobertura_codigo,
    disponibilidad_municipal, coste, requiere_registro, formato_datos,
    tematica_inspire, notas_limitaciones, capabilities, pts_tematica,
    pts_cobertura, pts_fuente, pts_tecnica, total_pts, prioridad_app,
    justificacion_prioridad, estado_revision, referencia

COLUMNAS NUEVAS (respecto a la versión anterior del script):
    id_estable              → identificador opcional declarado a mano.
                               Si está presente, se usa en vez del slug
                               autogenerado. Motivo: el slug se deriva de
                               proveedor+nombre_capa+tipo, así que una simple
                               corrección de nombre en el Excel cambia el id
                               y rompe la trazabilidad con curaciones previas
                               hechas sobre el id anterior (ver 3DECISIONS.md).
    tags                     → lista separada por comas, pasa tal cual al
                               JSON. No derivable de GetCapabilities, por lo
                               que se declara aquí en vez de vivir en un
                               archivo de overrides aparte (DRY: una sola
                               fuente de verdad).
    incluir_en_catalogo_final → "sí"/"no". Selección editorial de qué capas
                               pasan de catalogo-capas-ne.json (referencia
                               completa) al catálogo activo. La aplica la
                               ETAPA 2 (enriquecer-catalogo.py), no este
                               script — aquí solo se pasa el valor tal cual,
                               sin filtrar, porque catalogo-capas-ne.json debe
                               seguir siendo la referencia completa filtrada
                               solo por los 5 criterios de viabilidad técnica
                               de aplicar_filtros(), no por selección editorial.

CAMPO DEGRADADO A REFERENCIA (ya no es fuente de verdad):
    formato_datos → se conserva en el JSON de salida como
                     "formato_datos_manual_ref" (texto libre, sin parsear),
                     únicamente como apunte de trabajo para quien revisa el
                     Excel. YA NO alimenta formatos_salida/formato_consumo,
                     y YA NO se usa para excluir capas en este script bajo
                     ningún criterio (corrección 25/08/2026 — ver
                     3DECISIONS.md). Es texto libre inconsistente escrito a
                     mano; la fuente de verdad real de qué formatos ofrece
                     un servicio es el propio servicio, vía GetCapabilities,
                     resuelto exclusivamente en la ETAPA 2. Una versión
                     anterior de este script excluía aquí mismo los WFS
                     cuyo formato_datos no mencionara GeoJSON — se retiró
                     ese filtro porque un Excel mal transcrito podía perder
                     una capa con GeoJSON real en el servicio, sin que la
                     ETAPA 2 llegara a tener oportunidad de verificarla. La
                     exclusión real de WFS sin GeoJSON ahora ocurre
                     únicamente en enriquecer-catalogo.py::resolver_capa(),
                     contra el servicio real.

NORMALIZACIÓN DE tipo_acceso:
    El Excel puede contener valores como "OGC WFS" o "WFS / Descarga directa".
    El script los normaliza al tipo canónico ("WFS") antes de filtrar y exportar.
    Tipos reconocidos: WMS, WMTS, WFS, GEOJSON, ArcGIS_REST, FEATURE, WCS.
"""

import sys
import json
import re
import unicodedata
from pathlib import Path

try:
    import pandas as pd
except ImportError:
    print("❌ Falta la dependencia 'pandas'. Instálala con: pip install pandas openpyxl")
    sys.exit(1)


# ─────────────────────────────────────────────
# CONFIGURACIÓN
# ─────────────────────────────────────────────

ARCHIVO_SALIDA = "catalogo-capas-ne.json"

# Filtros de inclusión (viabilidad técnica, NO selección editorial —
# la selección editorial vive en incluir_en_catalogo_final y la aplica
# la ETAPA 2, no este script)
PRIORIDADES_INCLUIDAS   = {"P0 - MVP", "P1 - Alta", "P2 - Media"}
ESTADOS_INCLUIDOS       = {"Revisada"}
COSTES_INCLUIDOS        = {"Gratuita"}
DISPONIBILIDAD_EXCLUIDA = {"RECORTE", "LOTE"}  # no viables sin backend

MAPA_COBERTURA = {
    "Nacional":                    "nacional",
    "Autonómico":                  "autonomica",
    "Provincial o Supramunicipal": "provincial",
    "Municipal / Local":           "municipal",
    "Europeo":                     "europeo",
    "Global / Mundial":            "global",
}


# ─────────────────────────────────────────────
# UTILIDADES
# ─────────────────────────────────────────────

def slugify(texto: str, max_len: int = 60) -> str:
    """Convierte texto libre a kebab-case sin tildes."""
    texto = unicodedata.normalize("NFD", texto.lower())
    texto = "".join(c for c in texto if unicodedata.category(c) != "Mn")
    texto = re.sub(r"[^a-z0-9\s-]", "", texto)
    texto = re.sub(r"[\s-]+", "-", texto).strip("-")
    return texto[:max_len]


def limpiar(valor) -> str:
    if pd.isna(valor):
        return ""
    return str(valor).strip()


def normalizar_tipo(tipo_raw: str) -> str:
    TIPOS_CANONICOS = ["WMTS", "WFS", "WMS", "GEOJSON", "ArcGIS_REST", "FEATURE", "WCS"]
    tipo_upper = tipo_raw.upper()
    for tipo in TIPOS_CANONICOS:
        if tipo.upper() in tipo_upper:
            return tipo
    return tipo_raw


def construir_cobertura(cobertura_geografica: str, cobertura_codigo: str) -> dict:
    tipo = MAPA_COBERTURA.get(cobertura_geografica.strip())

    if not tipo:
        print(f"  ⚠  cobertura desconocida: '{cobertura_geografica}' → campo cobertura incompleto")
        return {"tipo": "desconocida"}

    cobertura = {"tipo": tipo}
    codigo = cobertura_codigo.strip()

    if tipo == "autonomica":
        if codigo:
            cobertura["ccaa_code"] = codigo
        else:
            print(f"  ⚠  falta cobertura_codigo para cobertura autonómica")
    elif tipo == "provincial":
        if codigo:
            cobertura["provincia_code"] = codigo
        else:
            print(f"  ⚠  falta cobertura_codigo para cobertura provincial")
    elif tipo == "municipal":
        if codigo:
            cobertura["codigos_ine"] = [c.strip() for c in codigo.split(",") if c.strip()]
        else:
            print(f"  ⚠  falta cobertura_codigo para cobertura municipal")

    return cobertura


def parsear_tags(raw: str) -> list:
    """tags: lista separada por comas en el Excel → lista JSON."""
    if not raw:
        return []
    return [t.strip() for t in raw.split(",") if t.strip()]


# ─────────────────────────────────────────────
# FILTROS DE INCLUSIÓN (viabilidad técnica)
# ─────────────────────────────────────────────

def aplicar_filtros(fila: pd.Series) -> tuple[bool, str]:
    """
    Filtros de VIABILIDAD TÉCNICA para entrar a catalogo-capas-ne.json.
    NO es la selección editorial de qué entra al catálogo activo — esa
    decisión vive en incluir_en_catalogo_final y la resuelve la ETAPA 2.

    CORRECCIÓN (hallazgo real, 25/08/2026): este filtro excluía WFS aquí
    mismo si formato_datos (texto libre escrito a mano) no mencionaba
    GeoJSON — pero formato_datos ya no es fuente de verdad para formatos
    (ver formato_datos_manual_ref). Si el Excel quedaba mal transcrito,
    una capa con GeoJSON real en el servicio se perdía aquí, ANTES de que
    la ETAPA 2 pudiera verificarla contra GetCapabilities real. La
    verificación real y autoritativa de soporte GeoJSON para WFS vive
    exclusivamente en enriquecer-catalogo.py::resolver_capa() — ahí sí se
    consulta el servicio real antes de excluir. Este script ya no excluye
    WFS por ese motivo bajo ninguna circunstancia.
    """
    coste     = limpiar(fila.get("coste", ""))
    estado    = limpiar(fila.get("estado_revision", ""))
    prioridad = limpiar(fila.get("prioridad_app", ""))
    disponib  = limpiar(fila.get("disponibilidad_municipal", "")).upper()

    if coste not in COSTES_INCLUIDOS:
        return False, f"coste: '{coste}'"
    if estado not in ESTADOS_INCLUIDOS:
        return False, f"estado_revision: '{estado}'"
    if prioridad not in PRIORIDADES_INCLUIDAS:
        return False, f"prioridad_app: '{prioridad}'"
    if disponib in DISPONIBILIDAD_EXCLUIDA:
        return False, f"disponibilidad_municipal: '{disponib}'"

    return True, ""


# ─────────────────────────────────────────────
# TRANSFORMACIÓN DE FILAS
# ─────────────────────────────────────────────

def transformar_fila(fila: pd.Series, ids_usados: set) -> dict:
    proveedor    = limpiar(fila.get("proveedor", ""))
    nombre_capa  = limpiar(fila.get("nombre_capa", ""))
    tipo_acceso  = normalizar_tipo(limpiar(fila.get("tipo_acceso", "")))
    id_manual    = limpiar(fila.get("id_estable", ""))

    # id_estable tiene prioridad sobre el slug autogenerado — evita que
    # una corrección de nombre/proveedor en el Excel rompa la trazabilidad
    # con curaciones ya hechas sobre el id anterior.
    if id_manual:
        capa_id = slugify(id_manual, max_len=80)
    else:
        capa_id = slugify(f"{proveedor}-{nombre_capa}-{tipo_acceso}")

    id_final = capa_id
    sufijo_n = 1
    while id_final in ids_usados:
        id_final = f"{capa_id}-{sufijo_n}"
        sufijo_n += 1
    ids_usados.add(id_final)

    def to_int(campo):
        try:
            return int(float(limpiar(fila.get(campo, "0")) or "0"))
        except ValueError:
            return 0

    return {
        "id":    id_final,
        "title": nombre_capa,

        "bloque_tematico": limpiar(fila.get("bloque_tematico", "")),
        "subtema":         limpiar(fila.get("subtema", "")),
        "proveedor":       proveedor,

        "tipo": tipo_acceso,
        "url":              limpiar(fila.get("url_endpoint", "")),
        "capabilities_url": limpiar(fila.get("capabilities", "")) or None,

        # Ya NO se calculan aquí formatos_salida/formato_consumo — los
        # resuelve la ETAPA 2 contra el servicio real. Se conserva el
        # texto original solo como apunte de trabajo, sin parsear.
        "formato_datos_manual_ref": limpiar(fila.get("formato_datos", "")),

        "inspire":    limpiar(fila.get("tematica_inspire", "")),
        "notas":      limpiar(fila.get("notas_limitaciones", "")),
        "referencia": limpiar(fila.get("referencia", "")) or None,

        "requiere_registro": limpiar(fila.get("requiere_registro", "")).lower() in ("sí", "si", "yes", "true"),
        "coste":   limpiar(fila.get("coste", "")),
        "visible": False,

        "disponibilidad_municipal": limpiar(fila.get("disponibilidad_municipal", "")),

        "puntuacion": {
            "tematica":  to_int("pts_tematica"),
            "cobertura": to_int("pts_cobertura"),
            "fuente":    to_int("pts_fuente"),
            "tecnica":   to_int("pts_tecnica"),
            "total":     to_int("total_pts"),
        },

        "prioridad": limpiar(fila.get("prioridad_app", "")),

        "cobertura": construir_cobertura(
            limpiar(fila.get("cobertura_geografica", "")),
            limpiar(fila.get("cobertura_codigo", "")),
        ),

        # Pass-through sin filtrar — la ETAPA 2 decide qué hacer con esto.
        "tags": parsear_tags(limpiar(fila.get("tags", ""))),
        "incluir_en_catalogo_final": limpiar(fila.get("incluir_en_catalogo_final", "")).lower() in ("sí", "si", "yes", "true"),
    }


# ─────────────────────────────────────────────
# LECTURA DEL ARCHIVO
# ─────────────────────────────────────────────

def leer_archivo(ruta: Path) -> pd.DataFrame:
    sufijo = ruta.suffix.lower()

    if sufijo == ".xlsx":
        return pd.read_excel(ruta, dtype=str)
    elif sufijo == ".csv":
        try:
            df = pd.read_csv(ruta, sep="\t", dtype=str, encoding="utf-8")
            if df.shape[1] > 1:
                return df
        except Exception:
            pass
        return pd.read_csv(ruta, sep=",", dtype=str, encoding="utf-8")
    else:
        print(f"❌ Formato no soportado: {sufijo}. Usa .xlsx o .csv")
        sys.exit(1)


# ─────────────────────────────────────────────
# EJECUCIÓN PRINCIPAL
# ─────────────────────────────────────────────

def main():
    print("═══════════════════════════════════════════")
    print("  Migración Excel → catalogo-capas-ne.json")
    print("═══════════════════════════════════════════\n")

    if len(sys.argv) < 2:
        print("USO: python migrar-catalogo.py <archivo.xlsx|archivo.csv>")
        sys.exit(1)

    ruta_entrada = Path(sys.argv[1])
    if not ruta_entrada.exists():
        print(f"❌ Archivo no encontrado: {ruta_entrada}")
        sys.exit(1)

    df = leer_archivo(ruta_entrada)
    df.columns = df.columns.str.strip()
    print(f"📄 Filas leídas: {len(df)}\n")

    catalogo   = []
    excluidas  = []
    ids_usados = set()

    for i, fila in df.iterrows():
        nombre = limpiar(fila.get("nombre_capa", f"fila {i+2}"))
        incluida, motivo = aplicar_filtros(fila)

        if not incluida:
            excluidas.append({"nombre": nombre, "motivo": motivo})
            continue

        capa = transformar_fila(fila, ids_usados)
        catalogo.append(capa)
        marca_final = "→ candidata a catálogo final" if capa["incluir_en_catalogo_final"] else ""
        print(f"  ✅ {nombre} {marca_final}")

    ruta_salida = ruta_entrada.parent / ARCHIVO_SALIDA
    with open(ruta_salida, "w", encoding="utf-8") as f:
        json.dump(catalogo, f, ensure_ascii=False, indent=2)

    print("\n───────────────────────────────────────────")
    print(f"✅ Capas incluidas en referencia:  {len(catalogo)}")
    print(f"   de ellas, candidatas a catálogo final: "
          f"{sum(1 for c in catalogo if c['incluir_en_catalogo_final'])}")
    print(f"❌ Capas excluidas: {len(excluidas)}")

    if excluidas:
        print(f"\nExclusiones ({len(excluidas)}):")
        for e in excluidas:
            print(f"   - {e['nombre']} → {e['motivo']}")

    print(f"\n📦 Archivo generado: {ruta_salida}")
    print("═══════════════════════════════════════════\n")


if __name__ == "__main__":
    main()