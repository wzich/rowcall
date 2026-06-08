const PYTHON_TYPE_LABELS: Record<string, string> = {
  "builtins.bool": "bool",
  "builtins.dict": "dict",
  "builtins.float": "float",
  "builtins.int": "int",
  "builtins.list": "list",
  "builtins.str": "str",
  "builtins.tuple": "tuple",
  "pandas.core.frame.DataFrame": "pandas.DataFrame",
  "pandas.core.series.Series": "pandas.Series",
  "polars.dataframe.frame.DataFrame": "polars.DataFrame",
  "polars.series.series.Series": "polars.Series",
};

export function formatPythonType(typeName: string): string {
  return PYTHON_TYPE_LABELS[typeName] ?? typeName.split(".").at(-1) ??
    typeName;
}
