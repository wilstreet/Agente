---
name: registro-proveedor
description: Conocimiento del proceso de registro como proveedor para Periferia IT Group
---

# Proceso: Registro como Proveedor

## Estructura de fixtures
- Cada caso vive en `fixtures/reto-01/casos/<caso>/`
- `solicitud.json`: correo normalizado con `{ id, pais, cliente, formato, adjuntos[] }`
- `plantilla-celdas.json`: para formato xlsx — `{ hoja, celda_etiqueta, etiqueta, celda_valor }[]`
- `plantilla-campos.json`: para formato pdf — `{ etiqueta, obligatorio }[]`
- `soportes-exigidos.json`: lista de tipos de soporte requeridos

## Repositorio maestro
- `fixtures/reto-01/repositorio/maestro.json`: datos de Periferia en `snake_case`
- `fixtures/reto-01/repositorio/soportes/index.json`: soportes con `tipo`, `archivo`, `vigencia_hasta`
- `fixtures/reto-01/glosario-campos.json`: sinónimos de etiquetas → clave del maestro

## Reglas de negocio
- Identificador tributario: CO→NIT, EC/PE/PA→RUC, HN→RTN. Periferia solo tiene NIT; para otros países se usa el NIT y se marca `requiere_confirmacion`.
- Datos bancarios solo si la plantilla los pide explícitamente. Nunca en el borrador de correo.
- Soporte vencido (`vigencia_hasta` < hoy) → bloquea `listo_para_firma`.
- Soporte exigido ausente → bloquea `listo_para_firma`.
- Campo faltante → NO bloquea, pero aparece en checklist.
