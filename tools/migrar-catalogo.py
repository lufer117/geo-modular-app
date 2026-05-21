"""
migrar-catalogo.py

Script de transformación: Excel (.xlsx) o CSV → catalogo-capas.json

USO:
    Opción A — desde Excel directamente (recomendado):
        python migrar-catalogo.py capas.xlsx

    Opción B — desde CSV exportado:
        python migrar-catalogo.py capas.csv

    El archivo catalogo-capas.json se genera en la misma carpeta.

REQUISITOS:
    pip install openpyxl pandas

COLUMNAS ESPERADAS EN EL EXCEL/CSV:
    bloque_tematico, subtema, nombre_capa, proveedor, tipo_acceso,
    url_endpoint, cobertura_geografica, cobertura_codigo,
    disponibilidad_municipal, coste, requiere_registro, formato_datos,
    tematica_inspire, notas_limitaciones, capabilities, pts_tematica,
    pts_cobertura, pts_fuente, pts_tecnica, total_pts, prioridad_app,
    justificacion_prioridad, estado_revision, referencia

NORMALIZACIÓN DE tipo_acceso:
    El Excel puede contener valores como "OGC WFS" o "WFS / Descarga directa".
    El script los normaliza al tipo canónico ("WFS") antes de filtrar y exportar.
    Tipos reconocidos: WMS, WMTS, WFS, GEOJSON, ArcGIS_REST, FEATURE, WCS.

CAMPOS NUEVOS EN EL JSON DE SALIDA (respecto a versión anterior):
    formatos_salida  → lista de formatos que el servicio declara ofrecer
                       Ejemplo: ["GML", "GeoJSON", "KML"]
    formato_consumo  → formato concreto que usará layerFactory para consumir el servicio
                       Ejemplo: "GeoJSON"
                       Para WFS: se fuerza a "GeoJSON" (requerimiento de WFSLayer SDK v5)
                       Si un WFS no ofrece GeoJSON → capa excluida con motivo explícito

CAMPO ELIMINADO:
    formato  → era siempre vacío y no tenía semántica. Reemplazado por los dos campos anteriores.
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

# Filtros de inclusión
PRIORIDADES_INCLUIDAS   = {"P0 - MVP", "P1 - Alta", "P2 - Media"}
ESTADOS_INCLUIDOS       = {"Revisada"}
COSTES_INCLUIDOS        = {"Gratuita"}
DISPONIBILIDAD_EXCLUIDA = {"RECORTE", "LOTE"}  # no viables sin backend

# Alias normalizados a "GeoJSON" canónico al parsear la columna formato_datos.
# El campo del Excel puede traer variantes como "geojson", "GeoJson", "json", "geojson/"
_GEOJSON_ALIASES = {"geojson", "json", "geojson/"}

# Mapeo cobertura_geografica → cobertura.tipo (valores del JSON de arquitectura)
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
    """
    Convierte texto libre a kebab-case sin tildes.
    Ejemplo: "FEGA - MAPA" + "WMS SIGPAC" → "fega-mapa-wms-sigpac"
    """
    texto = unicodedata.normalize("NFD", texto.lower())
    texto = "".join(c for c in texto if unicodedata.category(c) != "Mn")
    texto = re.sub(r"[^a-z0-9\s-]", "", texto)
    texto = re.sub(r"[\s-]+", "-", texto).strip("-")
    return texto[:max_len]


def limpiar(valor) -> str:
    """Convierte NaN de pandas a cadena vacía y elimina espacios."""
    if pd.isna(valor):
        return ""
    return str(valor).strip()


def parsear_formatos(raw: str) -> list:
    """
    Convierte la cadena de formatos del Excel en una lista normalizada.

    Entrada:  "GML/XML/GeoJson/KML"  |  "SHP; GeoJSON; KML"  |  "GML / XML"
    Salida:   ["GML", "XML", "GeoJSON", "KML"]

    Separadores reconocidos: / ; ,  (NO espacios).
    El espacio NO es separador porque algunos campos del Excel contienen texto libre
    tras los formatos reales, ej: "GML / XML; formatos adicionales según GetCapabilities".
    Partir por espacios produciría tokens basura como "formatos", "adicionales", etc.

    Filtro de tokens:
      - Se descartan tokens de más de 20 caracteres (texto libre, no nombres de formato).
      - Se descartan tokens que empiezan por minúscula (frases en español, no acrónimos).
      - Se normalizan variantes de GeoJSON → "GeoJSON" canónico.

    Devuelve lista vacía si la entrada está vacía.
    """
    if not raw:
        return []

    # Pre-normalizar MIME types OGC antes de partir por separadores.
    # 'application/json' y 'application/geo+json' usan '/' internamente,
    # por lo que se partirían en tokens 'application' + 'json' (ambos en minúscula
    # y por tanto descartados por el filtro de texto libre).
    # Solución: sustituirlos por el token canónico 'GeoJSON' antes del split.
    raw = re.sub(r'application/geo\+json', 'GeoJSON', raw, flags=re.IGNORECASE)
    raw = re.sub(r'application/json',      'GeoJSON', raw, flags=re.IGNORECASE)

    # Partir solo por separadores duros; los espacios son parte del texto de cada token
    partes = re.split(r'[/;,]+', raw.strip())
    resultado = []

    for p in partes:
        p = p.strip()
        if not p:
            continue

        # Descartar texto libre: los nombres de formato son cortos y en mayúsculas/mixto
        if len(p) > 20:
            continue
        if p[0].islower():   # "formatos adicionales..." empieza en minúscula → texto libre
            continue

        # Normalizar variantes de GeoJSON a la forma canónica
        if p.lower().replace(" ", "") in _GEOJSON_ALIASES:
            resultado.append("GeoJSON")
        else:
            resultado.append(p)

    return resultado


def normalizar_tipo(tipo_raw: str) -> str:
    """
    Normaliza los valores de tipo_acceso del Excel al tipo canónico de layerFactory.

    El Excel puede contener valores no homogéneos escritos por humanos:
      "OGC WFS"                → "WFS"
      "WFS / Descarga directa" → "WFS"
      "WMS"                    → "WMS"
      "WMTS"                   → "WMTS"

    Estrategia: buscar el tipo canónico como subcadena del valor en mayúsculas.
    Orden de búsqueda importa: "ArcGIS_REST" antes de tokens genéricos.

    Si no hay coincidencia, devuelve el valor original para que layerFactory
    emita console.warn con el tipo desconocido (fail visible, no silencioso).
    """
    # Orden deliberado: los tipos más específicos primero
    TIPOS_CANONICOS = ["WMTS", "WFS", "WMS", "GEOJSON", "ArcGIS_REST", "FEATURE", "WCS"]
    tipo_upper = tipo_raw.upper()

    for tipo in TIPOS_CANONICOS:
        if tipo.upper() in tipo_upper:
            return tipo

    return tipo_raw  # fallback: devolver original → layerFactory lo logeará como desconocido


def determinar_formato_consumo(tipo: str, formatos: list) -> str | None:
    """
    Determina el formato que layerFactory usará para consumir el servicio.

    ── WFS ──────────────────────────────────────────────────────────────────
    WFSLayer del SDK v5 necesita GeoJSON internamente.
    Si el servicio no lo ofrece, devuelve None → señal para excluir la capa.
    Decisión provisional: llevar al tutor si se necesita proxy GML→GeoJSON.

    ── Resto de tipos ───────────────────────────────────────────────────────
    Devuelve el primer formato declarado, o cadena vacía si no hay ninguno.
    (WMS, WMTS y otros no necesitan negociación de formato en este prototipo.)

    @param tipo     Valor canónico ya normalizado por normalizar_tipo() (ej. "WFS", "WMS")
    @param formatos Lista producida por parsear_formatos()
    @returns        String con el formato a usar, o None si la capa no es consumible
    """
    if tipo.upper() == "WFS":
        return "GeoJSON" if "GeoJSON" in formatos else None

    return formatos[0] if formatos else ""


def construir_cobertura(cobertura_geografica: str, cobertura_codigo: str) -> dict:
    """
    Construye el objeto cobertura a partir de los campos del Excel.

    cobertura_codigo puede ser:
      - vacío           → nacional, europeo, global (no lo necesitan)
      - "15"            → código CCAA (autonómica)
      - "31"            → código provincia (provincial)
      - "31201,31007"   → códigos INE separados por coma (municipal)
    """
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

    # nacional, europeo, global: no necesitan código adicional

    return cobertura


# ─────────────────────────────────────────────
# FILTROS DE INCLUSIÓN
# ─────────────────────────────────────────────

def aplicar_filtros(fila: pd.Series) -> tuple[bool, str]:
    """
    Aplica todos los filtros de inclusión sobre una fila del Excel.
    Devuelve (incluida: bool, motivo_exclusion: str).

    Orden de checks:
      1. Coste → solo capas gratuitas
      2. Estado → solo capas revisadas
      3. Prioridad → P0, P1, P2
      4. Disponibilidad → excluye RECORTE y LOTE (requieren backend)
      5. WFS sin GeoJSON → no consumible con WFSLayer SDK v5 sin proxy
    """
    coste     = limpiar(fila.get("coste", ""))
    estado    = limpiar(fila.get("estado_revision", ""))
    prioridad = limpiar(fila.get("prioridad_app", ""))
    disponib  = limpiar(fila.get("disponibilidad_municipal", "")).upper()
    tipo      = normalizar_tipo(limpiar(fila.get("tipo_acceso", "")))
    formatos_raw = limpiar(fila.get("formato_datos", ""))

    if coste not in COSTES_INCLUIDOS:
        return False, f"coste: '{coste}'"

    if estado not in ESTADOS_INCLUIDOS:
        return False, f"estado_revision: '{estado}'"

    if prioridad not in PRIORIDADES_INCLUIDAS:
        return False, f"prioridad_app: '{prioridad}'"

    if disponib in DISPONIBILIDAD_EXCLUIDA:
        return False, f"disponibilidad_municipal: '{disponib}'"

    # Filtro WFS: WFSLayer del SDK v5 requiere GeoJSON como formato de salida.
    # Si el servicio no lo ofrece, la capa no es consumible desde cliente sin proxy.
    # Decisión provisional — pendiente de validar con el tutor.
    if tipo == "WFS":
        formatos = parsear_formatos(formatos_raw)
        if "GeoJSON" not in formatos:
            formatos_str = ", ".join(formatos) if formatos else "no declarados"
            return False, f"WFS sin soporte GeoJSON — formatos disponibles: [{formatos_str}]"

    return True, ""


# ─────────────────────────────────────────────
# TRANSFORMACIÓN DE FILAS
# ─────────────────────────────────────────────

def transformar_fila(fila: pd.Series) -> dict:
    """
    Convierte una fila del Excel/CSV en un objeto de capa para catalogo-capas.json.

    Cambios respecto a la versión anterior:
      - Eliminado: "formato" (siempre vacío, sin semántica)
      - Añadido:   "formatos_salida" (lista de lo que el servicio ofrece)
      - Añadido:   "formato_consumo" (el que usará layerFactory — para WFS, siempre GeoJSON)
    """
    proveedor    = limpiar(fila.get("proveedor", ""))
    nombre_capa  = limpiar(fila.get("nombre_capa", ""))
    tipo_acceso  = normalizar_tipo(limpiar(fila.get("tipo_acceso", "")))
    formatos_raw = limpiar(fila.get("formato_datos", ""))

    formatos        = parsear_formatos(formatos_raw)
    formato_consumo = determinar_formato_consumo(tipo_acceso, formatos)

    capa_id = slugify(f"{proveedor}-{nombre_capa}-{tipo_acceso}")

    def to_int(campo):
        try:
            return int(float(limpiar(fila.get(campo, "0")) or "0"))
        except ValueError:
            return 0

    return {
        "id":    capa_id,
        "title": nombre_capa,

        "bloque_tematico": limpiar(fila.get("bloque_tematico", "")),
        "subtema":         limpiar(fila.get("subtema", "")),
        "proveedor":       proveedor,

        "tipo":             tipo_acceso,         # tipo canónico normalizado → alimenta layerFactory._TIPO_MAP
        "url":              limpiar(fila.get("url_endpoint", "")),
        "capabilities_url": limpiar(fila.get("capabilities", "")) or None,

        # ── Campos de formato (reemplazan al antiguo "formato": "") ──────────
        # formatos_salida: lo que el servicio declara que puede entregar.
        #   Útil para documentación, auditoría y futura lógica de adaptadores.
        "formatos_salida": formatos,

        # formato_consumo: el formato que layerFactory usará para instanciar la capa.
        #   Para WFS siempre es "GeoJSON" (requerimiento de WFSLayer SDK v5).
        #   Para otros tipos, primer formato declarado o cadena vacía.
        #   None aquí no debería llegar (el filtro de inclusión lo habrá excluido antes).
        "formato_consumo": formato_consumo,
        # ────────────────────────────────────────────────────────────────────

        "inspire":    limpiar(fila.get("tematica_inspire", "")),
        "notas":      limpiar(fila.get("notas_limitaciones", "")),
        "referencia": limpiar(fila.get("referencia", "")) or None,

        "requiere_registro": limpiar(fila.get("requiere_registro", "")).lower() in ("sí", "si", "yes", "true"),
        "coste":   limpiar(fila.get("coste", "")),
        "visible": False,  # siempre False — las capas arrancan ocultas, el usuario las activa

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
    }


# ─────────────────────────────────────────────
# LECTURA DEL ARCHIVO
# ─────────────────────────────────────────────

def leer_archivo(ruta: Path) -> pd.DataFrame:
    """Lee Excel (.xlsx) o CSV y devuelve un DataFrame."""
    sufijo = ruta.suffix.lower()

    if sufijo == ".xlsx":
        return pd.read_excel(ruta, dtype=str)

    elif sufijo == ".csv":
        # Intenta tabulador primero (exportación directa desde Excel).
        # Si falla o produce una sola columna, reintenta con coma.
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
    print("  Migración Excel → catalogo-capas.json")
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

        capa = transformar_fila(fila)

        # Garantizar IDs únicos ante colisiones de slug
        id_final = capa["id"]
        sufijo_n = 1
        while id_final in ids_usados:
            id_final = f"{capa['id']}-{sufijo_n}"
            sufijo_n += 1
        capa["id"] = id_final
        ids_usados.add(id_final)

        catalogo.append(capa)
        print(f"  ✅ {nombre}")

    # Escribir JSON
    ruta_salida = ruta_entrada.parent / ARCHIVO_SALIDA
    with open(ruta_salida, "w", encoding="utf-8") as f:
        json.dump(catalogo, f, ensure_ascii=False, indent=2)

    # ── Resumen ───────────────────────────────
    print("\n───────────────────────────────────────────")
    print(f"✅ Capas incluidas:  {len(catalogo)}")
    print(f"❌ Capas excluidas: {len(excluidas)}")

    if excluidas:
        # Agrupar por motivo para lectura rápida
        wfs_sin_geojson = [e for e in excluidas if "WFS sin soporte GeoJSON" in e["motivo"]]
        otros           = [e for e in excluidas if "WFS sin soporte GeoJSON" not in e["motivo"]]

        if wfs_sin_geojson:
            print(f"\n⚠️  WFS excluidos por falta de GeoJSON ({len(wfs_sin_geojson)}) — pendiente de hablar con el tutor:")
            for e in wfs_sin_geojson:
                print(f"   - {e['nombre']} → {e['motivo']}")

        if otros:
            print(f"\nOtras exclusiones ({len(otros)}):")
            for e in otros:
                print(f"   - {e['nombre']} → {e['motivo']}")

    print(f"\n📦 Archivo generado: {ruta_salida}")
    print("═══════════════════════════════════════════\n")


if __name__ == "__main__":
    main()