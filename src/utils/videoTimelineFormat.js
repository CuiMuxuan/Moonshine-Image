export const formatTimelineDuration = (input) => {
  const numeric = Number(input);
  const safeSeconds = Number.isFinite(numeric) ? Math.max(numeric, 0) : 0;
  const totalTenths = Math.round(safeSeconds * 10);
  const tenthsPerMinute = 60 * 10;
  const tenthsPerHour = 60 * tenthsPerMinute;
  const hours = Math.floor(totalTenths / tenthsPerHour);
  const minutes = Math.floor((totalTenths % tenthsPerHour) / tenthsPerMinute);
  const seconds = (totalTenths % tenthsPerMinute) / 10;
  const secondText = `${seconds.toFixed(1)}s`;

  if (hours > 0) {
    return `${hours}h${minutes}m${secondText}`;
  }
  if (minutes > 0) {
    return `${minutes}m${secondText}`;
  }
  return secondText;
};
