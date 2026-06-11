import axios from "axios";
import FormData from "form-data";
import { config } from "./config";

export type ImportJob = {
  id: number;
  source_url: string;
  source_name: string;
  start_chap: string;
  end_chap: string;
  status: string;
  series_id: string | null;
  series_name: string | null;
};

export async function getNextImportJob(): Promise<ImportJob | null> {
  const response = await axios.get(
    `${config.api.baseUrl}/worker/import_job_next.php`,
    {
      headers: {
        Authorization: `Bearer ${config.api.token}`,
      },
      timeout: 30000,
    }
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

  const response = await axios.post(
    `${config.api.baseUrl}/worker/import_job_update.php`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${config.api.token}`,
      },
      timeout: 30000,
    }
  );

  if (!response.data?.success) {
    throw new Error(`Job status update failed: ${JSON.stringify(response.data)}`);
  }

  return response.data;
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

  const response = await axios.post(
    `${config.api.baseUrl}/worker/series_upsert.php`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${config.api.token}`,
      },
      timeout: 30000,
    }
  );

  if (!response.data?.success) {
    throw new Error(`Series upsert failed: ${JSON.stringify(response.data)}`);
  }

  return {
    series_id: Number(response.data.series_id),
    seriesuid: response.data.seriesuid,
  };
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

  const response = await axios.post(
    `${config.api.baseUrl}/worker/chapter_upsert.php`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${config.api.token}`,
      },
      timeout: 30000,
    }
  );

  if (!response.data?.success) {
    throw new Error(`Chapter upsert failed: ${JSON.stringify(response.data)}`);
  }

  return response.data;
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

  const response = await axios.post(
    `${config.api.baseUrl}/worker/series_category_upsert.php`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${config.api.token}`,
      },
      timeout: 30000,
    }
  );

  if (!response.data?.success) {
    throw new Error(
      `Series category upsert failed: ${JSON.stringify(response.data)}`
    );
  }

  return response.data;
}