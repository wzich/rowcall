export async function resolveExistingDocumentPath(
  path: string,
): Promise<string> {
  try {
    const stat = await Deno.stat(path);
    if (stat.isDirectory) {
      const documentPath = `${path.replace(/\/+$/, "")}/graph.py`;
      const documentStat = await Deno.stat(documentPath).catch((error) => {
        if (error instanceof Deno.errors.NotFound) return null;
        throw error;
      });
      if (!documentStat?.isFile) {
        throw new Error(
          `Rowcall folder does not contain graph.py: ${path}\n\nCreate it with:\n  rowcall new ${path}`,
        );
      }
      return documentPath;
    }
    if (!stat.isFile) {
      throw new Error(`Rowcall path is not a file or directory: ${path}`);
    }
    if (!path.endsWith(".py")) {
      throw new Error(
        "Rowcall document path must be a .py file or a folder containing graph.py.",
      );
    }
    return path;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  const noun = path.endsWith(".py") ? "Rowcall document" : "Rowcall folder";
  throw new Error(
    `Path not found: ${path}\n\nCreate a new ${noun}:\n  rowcall new ${path}\n\nCreate and open it:\n  rowcall new ${path} --open`,
  );
}
