"""Fine-tune Nexion with Unsloth using the project's JSONL prompt/response data.

Run this in Linux or WSL with an NVIDIA GPU. The output is a LoRA adapter that
can be loaded by Transformers or merged/exported for Ollama.
"""
import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA = ROOT / "training"
DEFAULT_OUTPUT = ROOT / "models" / "nexion-unsloth-lora"
SYSTEM_PROMPT = (
    "You are Nexion, a warm and capable local AI assistant. "
    "Give accurate, practical answers. When asked for code, return complete "
    "runnable examples in fenced Markdown code blocks and explain them briefly. "
    "Distinguish facts from guesses and say when you are uncertain."
)


def read_examples(data_dir: Path) -> list[dict[str, str]]:
    files = sorted(data_dir.glob("*.jsonl"))
    if not files:
        raise ValueError(f"No .jsonl training files found in {data_dir}.")

    examples: list[dict[str, str]] = []
    for source in files:
        with source.open(encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ValueError(
                        f"Invalid JSON in {source}:{line_number}: {error.msg}"
                    ) from error
                prompt = row.get("prompt")
                response = row.get("response")
                if not isinstance(prompt, str) or not isinstance(response, str):
                    raise ValueError(
                        f"{source}:{line_number} needs string prompt and response fields."
                    )
                examples.append({"prompt": prompt.strip(), "response": response.strip()})

    if not examples:
        raise ValueError("The JSONL files contain no usable examples.")
    return examples


def main() -> None:
    parser = argparse.ArgumentParser(description="Fine-tune Nexion with Unsloth LoRA.")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--base-model",
        default="unsloth/Llama-3.2-1B-Instruct",
        help="Hugging Face model compatible with Unsloth.",
    )
    parser.add_argument("--epochs", type=float, default=3.0)
    parser.add_argument("--max-seq-length", type=int, default=2048)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--grad-accumulation", type=int, default=4)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument(
        "--save-method",
        choices=["lora", "merged_16bit", "merged_4bit"],
        default="lora",
        help="How to save the trained model. Use merged_16bit to export a "
        "standalone full LLM checkpoint instead of only a LoRA adapter.",
    )
    parser.add_argument(
        "--export-gguf",
        action="store_true",
        help="Also export a GGUF file (for Ollama/llama.cpp). Requires llama.cpp "
        "converted tooling and enough disk space.",
    )
    parser.add_argument(
        "--gguf-quant",
        default="q4_k_m",
        help="GGUF quantization method when --export-gguf is set.",
    )
    args = parser.parse_args()

    examples = read_examples(args.data_dir)

    from datasets import Dataset
    from transformers import TrainingArguments
    from trl import SFTTrainer
    from unsloth import FastLanguageModel

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.base_model,
        max_seq_length=args.max_seq_length,
        load_in_4bit=True,
        dtype=None,
    )
    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        target_modules=[
            "q_proj",
            "k_proj",
            "v_proj",
            "o_proj",
            "gate_proj",
            "up_proj",
            "down_proj",
        ],
        lora_alpha=16,
        lora_dropout=0,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=3407,
        use_rslora=False,
        loftq_config=None,
    )

    def to_text(example: dict[str, str]) -> dict[str, str]:
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": example["prompt"]},
            {"role": "assistant", "content": example["response"]},
        ]
        return {
            "text": tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=False,
            )
        }

    dataset = Dataset.from_list(examples).map(to_text)
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        dataset_text_field="text",
        max_seq_length=args.max_seq_length,
        packing=True,
        args=TrainingArguments(
            output_dir=str(args.output_dir),
            per_device_train_batch_size=args.batch_size,
            gradient_accumulation_steps=args.grad_accumulation,
            num_train_epochs=args.epochs,
            learning_rate=args.learning_rate,
            logging_steps=1,
            save_strategy="epoch",
            optim="adamw_8bit",
            fp16=True,
            report_to="none",
            seed=3407,
        ),
    )
    result = trainer.train()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    gguf_path = None
    if args.save_method == "lora":
        model.save_pretrained(args.output_dir)
        tokenizer.save_pretrained(args.output_dir)
        method = "QLoRA adapter; base model weights unchanged"
    else:
        # Merge the adapter into the base weights to produce a standalone LLM.
        model.save_pretrained_merged(
            str(args.output_dir),
            tokenizer,
            save_method=args.save_method,
        )
        method = f"merged standalone model ({args.save_method})"

    if args.export_gguf:
        quant = None if args.gguf_quant.lower() in {"f16", "fp16", "none"} else args.gguf_quant
        model.save_pretrained_gguf(
            str(args.output_dir),
            tokenizer,
            quantization_method=quant or "f16",
        )
        gguf_path = str(args.output_dir)

    print(
        json.dumps(
            {
                "trained": True,
                "examples": len(examples),
                "base_model": args.base_model,
                "output": str(args.output_dir),
                "train_loss": result.training_loss,
                "method": method,
                "save_method": args.save_method,
                "gguf_exported": bool(gguf_path),
            }
        )
    )


if __name__ == "__main__":
    main()
