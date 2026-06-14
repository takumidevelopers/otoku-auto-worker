import axios from "axios";
import FormData from "form-data";
import { config } from "./config";

export type ImportJob = {
  id: number;
  source_url: string;
  source_name: string;
  source?: string | null;
  start_chap: string;
  end_chap: string;
  status: string;
  series_id: string | null;
  series_name: string | null;

  external_series_id?: string | null;
  storage_type?: "auto" | "amazon" | "uploads" | string | null;
  is_adult?: string | number | boolean | null;
  page_start?: string | number | null;
  page_max?: string | number | null;
};

function apiUrl(path: string): string {
  const base = config.api.baseUrl.replace(/\/+$/, "");
  const cleanPath = path.replace(/^\/+/, "");
  return `${base}/${cleanPath}`;
}

function debugAxiosError(label: string, err: unknown): never {
  const anyErr = err as any;

  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : JSON.stringify(err);

  const url = anyErr?.config?.url ? String(anyErr.config.url) : "YOK";
  const method = anyErr?.config?.method ? String(anyErr.config.method) : "YOK";
  const status = anyErr?.response?.status ? String(anyErr.response.status) : "YOK";
  const data = anyErr?.response?.data
    ? typeof anyErr.response.data === "string"
      ? anyErr.response.data
      : JSON.stringify(anyErr.response.data)
    : "YOK";

  console.error(`========== ${label} AXIOS ERROR ==========`);
  console.error("MESSAGE:", message);
  console.error("METHOD:", method);
  console.error("URL:", url);
  console.error("STATUS:", status);
  console.error("RESPONSE:", data);
  console.error("=========================================");

  throw err;
}

export async function getNextImportJob(): Promise<ImportJob | null> {
  const url = apiUrl("/worker/import_job_next.php");

  console.log("[API] getNextImportJob URL:", url);

  let response;

  try {
    response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${config.api.token}`,
      },
      timeout: 30000,
    });
  } catch (err) {
    debugAxiosError("getNextImportJob", err);
  }

  console.log(
    "[API] getNextImportJob RESPONSE:",
    JSON.stringify(response.data, null, 2)
  );

  if (!response.data?.success || !response.data?.has_job) {
    return null;
  }

  return response.data.job;
}

export async function updateImportJobStatus(params: {
  jobId: number;
  status: "pending" | "running" | "completed" | "failed";
  seriesId?: string | null;
  seriesName?: string | null;
  errorMessage?: string | null;
}) {
  const form = new FormData();

  form.append("job_id", String(params.jobId));
  form.append("status", params.status);

  if (params.seriesId) form.append("series_id", params.seriesId);
  if (params.seriesName) form.append("series_name", params.seriesName);
  if (params.errorMessage) form.append("error_message", params.errorMessage);

  const url = apiUrl("/worker/import_job_update.php");

  try {
    const response = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${config.api.token}`,
      },
      timeout: 30000,
    });

    if (!response.data?.success) {
      throw new Error(`Job status update failed: ${JSON.stringify(response.data)}`);
    }

    return response.data;
  } catch (err) {
    debugAxiosError("updateImportJobStatus", err);
  }
}

export async function upsertSeries(params: {
  name: string;
  seriesuid: string;
  coverImageUrl: string;
  des: string;
  kaynak: string;
  final: string;
  searchName: string;
}): Promise<{ series_id: number; seriesuid: string }> {
  const form = new FormData();

  form.append("name", params.name);
  form.append("seriesuid", params.seriesuid);
  form.append("coverImageUrl", params.coverImageUrl);
  form.append("des", params.des);
  form.append("kaynak", params.kaynak);
  form.append("final", params.final);
  form.append("search_name", params.searchName);

  const url = apiUrl("/worker/series_upsert.php");

  try {
    const response = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${config.api.token}`,
      },
      timeout: 30000,
    });

    if (!response.data?.success) {
      throw new Error(`Series upsert failed: ${JSON.stringify(response.data)}`);
    }

    return {
      series_id: Number(response.data.series_id),
      seriesuid: response.data.seriesuid,
    };
  } catch (err) {
    debugAxiosError("upsertSeries", err);
  }
}

export async function upsertChapter(params: {
  eps: string;
  epsuid: string;
  seriesId: string | number;
  chapterurl: string;
}) {
  const form = new FormData();

  form.append("eps", params.eps);
  form.append("epsuid", params.epsuid);
  form.append("series_id", String(params.seriesId));
  form.append("chapterurl", params.chapterurl);

  const url = apiUrl("/worker/chapter_upsert.php");

  try {
    const response = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${config.api.token}`,
      },
      timeout: 30000,
    });

    if (!response.data?.success) {
      throw new Error(`Chapter upsert failed: ${JSON.stringify(response.data)}`);
    }

    return response.data;
  } catch (err) {
    debugAxiosError("upsertChapter", err);
  }
}

export async function upsertSeriesCategory(params: {
  seriesId: string;
  categoryId: string;
  categoryName: string;
}) {
  const form = new FormData();

  form.append("series_id", params.seriesId);
  form.append("categoryId", params.categoryId);
  form.append("categoryName", params.categoryName);

  const url = apiUrl("/worker/series_category_upsert.php");

  try {
    const response = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${config.api.token}`,
      },
      timeout: 30000,
    });

    if (!response.data?.success) {
      throw new Error(
        `Series category upsert failed: ${JSON.stringify(response.data)}`
      );
    }

    return response.data;
  } catch (err) {
    debugAxiosError("upsertSeriesCategory", err);
  }
}

export async function getAvailableSeriesSlug(baseSlug: string): Promise<string> {
  const form = new FormData();

  form.append("base_slug", baseSlug);

  const url = apiUrl("/worker/series_slug_available.php");

  try {
    const response = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${config.api.token}`,
      },
      timeout: 30000,
    });

    if (!response.data?.success || !response.data?.available_slug) {
      throw new Error(
        `Available slug check failed: ${JSON.stringify(response.data)}`
      );
    }

    return String(response.data.available_slug);
  } catch (err) {
    debugAxiosError("getAvailableSeriesSlug", err);
  }
}