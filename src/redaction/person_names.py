"""Pinned, local spaCy person recognition."""

import resource
import sys
from time import process_time

SPACY_VERSION = "3.8.18"
MODEL_VERSION = "3.8.0"
MODELS = {
    "eng": ("en_core_web_sm", "en", "PERSON"),
    "deu": ("de_core_news_sm", "de", "PER"),
}


class PersonNames:
    def __init__(self, language):
        started = process_time()
        import spacy
        from importlib.metadata import version

        package, locale, self.label = MODELS[language]
        if spacy.__version__ != SPACY_VERSION or version(package) != MODEL_VERSION:
            raise ValueError("local name model version does not match the pinned release")
        self.pipeline = spacy.load(
            package, exclude=["tagger", "parser", "senter", "morphologizer", "attribute_ruler", "lemmatizer"]
        )
        if (self.pipeline.lang != locale or self.pipeline.pipe_names != ["tok2vec", "ner"] or
                self.label not in self.pipeline.get_pipe("ner").labels):
            raise ValueError("invalid local name model")
        self.model = package + "-" + MODEL_VERSION
        self.load_cpu = process_time() - started
        self.inference_cpu = 0
        self.calls = 0
        self.detections = 0

    def spans(self, text):
        if not text.strip():
            return []
        started = process_time()
        spans = [(entity.start_char, entity.end_char) for entity in self.pipeline(text).ents
                 if entity.label_ == self.label]
        self.calls += 1
        self.detections += len(spans)
        self.inference_cpu += process_time() - started
        return spans

    def measurement(self):
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return {
            "model": self.model, "loadCpuSeconds": self.load_cpu,
            "inferenceCpuSeconds": self.inference_cpu, "calls": self.calls,
            "detections": self.detections,
            "peakRssBytes": peak if sys.platform == "darwin" else peak * 1024,
        }
