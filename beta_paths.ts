export type BetaPaths = {
  home: string;
  dataDir: string;
  venvDir: string;
  logsDir: string;
  logFile: string;
  configFile: string;
  updateCheckFile: string;
  bundledDir: string;
  bundledPythonPackageDir: string;
  bundledRequirementsPath: string;
  uiDistPath: string;
};

export function getBetaPaths(home = getHomeDirectory()): BetaPaths {
  const dataDir = `${home}/.rowcall`;
  const bundledDir = `${dataDir}/bundled`;
  return {
    home,
    dataDir,
    venvDir: `${dataDir}/venvs/default`,
    logsDir: `${dataDir}/logs`,
    logFile: `${dataDir}/logs/rowcall.log`,
    configFile: `${dataDir}/config.json`,
    updateCheckFile: `${dataDir}/update-check.json`,
    bundledDir,
    bundledPythonPackageDir: `${bundledDir}/python-package`,
    bundledRequirementsPath: `${bundledDir}/requirements-alpha.txt`,
    uiDistPath: `${bundledDir}/app/ui/dist`,
  };
}

export function getVenvPythonPath(venvDir: string): string {
  if (Deno.build.os === "windows") {
    return `${venvDir}/Scripts/python.exe`;
  }
  return `${venvDir}/bin/python`;
}

function getHomeDirectory(): string {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
  if (!home) {
    throw new Error("Could not determine the home directory.");
  }
  return home;
}
