import { useCallback } from "react";
import {
  useTranslation as useReactI18nextTranslation,
} from "react-i18next";
import type { i18n as I18nextInstance } from "i18next";
import { getLocale } from "./locale-state";
import { i18n, translate, type TranslationParams } from "./instance";

export type MobileTranslationFunction = (
  key: string,
  params?: TranslationParams,
) => string;

export type MobileTranslationResponse = [
  t: MobileTranslationFunction,
  i18n: I18nextInstance,
  ready: boolean,
] & {
  t: MobileTranslationFunction;
  i18n: I18nextInstance;
  ready: boolean;
};

/**
 * Bind react-i18next to the mobile instance and keep the legacy single-brace
 * parameter API used by existing non-React callers.
 */
export function useTranslation(): MobileTranslationResponse {
  getLocale();
  const response = useReactI18nextTranslation("translation", {
    i18n: i18n as I18nextInstance,
    useSuspense: false,
    bindI18n: "languageChanged",
  });
  const t = useCallback<MobileTranslationFunction>(
    (key, params) => translate(key, params),
    [response.t],
  );
  const result = [t, response.i18n, response.ready] as unknown as MobileTranslationResponse;
  result.t = t;
  result.i18n = response.i18n;
  result.ready = response.ready;
  return result;
}
