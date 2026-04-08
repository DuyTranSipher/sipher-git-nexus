#include "GitNexusBlueprintAnalyzerCommandlet.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "Blueprint/BlueprintSupport.h"
#include "Blueprint/UserWidget.h"
#include "Dom/JsonObject.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "Engine/Blueprint.h"
#include "EdGraphSchema_K2.h"
#include "K2Node_CallFunction.h"
#include "K2Node_CreateDelegate.h"
#include "K2Node_Event.h"
#include "K2Node_IfThenElse.h"
#include "K2Node_Switch.h"
#include "K2Node_VariableGet.h"
#include "K2Node_VariableSet.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/SoftObjectPath.h"
#include "UObject/GarbageCollection.h"
#include "Internationalization/Regex.h"
#include "GameplayTagContainer.h"

UGitNexusBlueprintAnalyzerCommandlet::UGitNexusBlueprintAnalyzerCommandlet()
{
	IsClient = false;
	IsEditor = true;
	LogToConsole = true;
	ShowErrorCount = true;
}

int32 UGitNexusBlueprintAnalyzerCommandlet::Main(const FString& Params)
{
	FString Operation;
	FString OutputJsonPath;
	FParse::Value(*Params, TEXT("Operation="), Operation);
	FParse::Value(*Params, TEXT("OutputJson="), OutputJsonPath);

	if (Operation.IsEmpty() || OutputJsonPath.IsEmpty())
	{
		UE_LOG(LogTemp, Error, TEXT("GitNexusBlueprintAnalyzer requires Operation= and OutputJson= parameters."));
		return 1;
	}

	if (Operation.Equals(TEXT("SyncAssets"), ESearchCase::IgnoreCase))
	{
		FString FilterJsonPath;
		FParse::Value(*Params, TEXT("FilterJson="), FilterJsonPath);
		// Legacy support: also check IgnoreJson= for backward compatibility
		if (FilterJsonPath.IsEmpty())
		{
			FParse::Value(*Params, TEXT("IgnoreJson="), FilterJsonPath);
		}
		FString ModeStr;
		FParse::Value(*Params, TEXT("Mode="), ModeStr);
		const bool bDeepMode = ModeStr.Equals(TEXT("deep"), ESearchCase::IgnoreCase);
		FString KnownAssetsJsonPath;
		FParse::Value(*Params, TEXT("KnownAssetsJson="), KnownAssetsJsonPath);
		return RunSyncAssets(OutputJsonPath, FilterJsonPath, bDeepMode, KnownAssetsJsonPath);
	}

	if (Operation.Equals(TEXT("FindNativeBlueprintReferences"), ESearchCase::IgnoreCase))
	{
		FString CandidatesJsonPath;
		FString TargetSymbolKey;
		FString TargetClassName;
		FString TargetFunctionName;
		FParse::Value(*Params, TEXT("CandidatesJson="), CandidatesJsonPath);
		FParse::Value(*Params, TEXT("TargetSymbolKey="), TargetSymbolKey);
		FParse::Value(*Params, TEXT("TargetClass="), TargetClassName);
		FParse::Value(*Params, TEXT("TargetFunction="), TargetFunctionName);
		return RunFindNativeBlueprintReferences(OutputJsonPath, CandidatesJsonPath, TargetSymbolKey, TargetClassName, TargetFunctionName);
	}

	if (Operation.Equals(TEXT("ExpandBlueprintChain"), ESearchCase::IgnoreCase))
	{
		FString AssetPath;
		FString ChainAnchorId;
		FString Direction = TEXT("downstream");
		int32 MaxDepth = 5;
		FParse::Value(*Params, TEXT("AssetPath="), AssetPath);
		FParse::Value(*Params, TEXT("ChainAnchorId="), ChainAnchorId);
		FParse::Value(*Params, TEXT("Direction="), Direction);
		FParse::Value(*Params, TEXT("MaxDepth="), MaxDepth);
		return RunExpandBlueprintChain(OutputJsonPath, AssetPath, ChainAnchorId, Direction, MaxDepth);
	}

	UE_LOG(LogTemp, Error, TEXT("Unsupported GitNexusBlueprintAnalyzer operation: %s"), *Operation);
	return 1;
}

// ── SyncAssets entry point ──────────────────────────────────────────────

int32 UGitNexusBlueprintAnalyzerCommandlet::RunSyncAssets(
	const FString& OutputJsonPath,
	const FString& FilterJsonPath,
	bool bDeepMode,
	const FString& KnownAssetsJsonPath)
{
	const FFilterPrefixes Filters = LoadFilterPrefixes(FilterJsonPath);
	const TArray<FAssetData> Assets = GetAllBlueprintAssets(Filters);

	if (bDeepMode)
	{
		const TMap<FString, FString> KnownAssets = LoadKnownAssets(KnownAssetsJsonPath);
		if (KnownAssets.Num() > 0)
		{
			UE_LOG(LogTemp, Display, TEXT("GitNexusBlueprintAnalyzer: Running in DEEP mode (incremental — %d known assets, unchanged will be skipped)"), KnownAssets.Num());
		}
		else
		{
			UE_LOG(LogTemp, Display, TEXT("GitNexusBlueprintAnalyzer: Running in DEEP mode (full Blueprint loading)"));
		}
		return RunSyncAssetsDeep(OutputJsonPath, Assets, KnownAssets);
	}

	UE_LOG(LogTemp, Display, TEXT("GitNexusBlueprintAnalyzer: Running in METADATA mode (no asset loading)"));
	return RunSyncAssetsMetadata(OutputJsonPath, Assets);
}

// ── Metadata-only sync (default) ────────────────────────────────────────
// Uses FAssetData tags + AssetRegistry dependencies. Zero asset loading.

int32 UGitNexusBlueprintAnalyzerCommandlet::RunSyncAssetsMetadata(
	const FString& OutputJsonPath,
	const TArray<FAssetData>& Assets)
{
	TArray<TSharedPtr<FJsonValue>> AssetValues;
	IAssetRegistry& AssetRegistry = IAssetRegistry::GetChecked();

	for (const FAssetData& AssetData : Assets)
	{
		TSharedPtr<FJsonObject> AssetObject = MakeShared<FJsonObject>();
		AssetObject->SetStringField(TEXT("asset_path"), AssetData.GetSoftObjectPath().ToString());
		AssetObject->SetStringField(TEXT("asset_class"), AssetData.AssetClassPath.ToString());

		// GeneratedClass from tag
		FString GeneratedClassTag;
		if (AssetData.GetTagValue(FBlueprintTags::GeneratedClassPath, GeneratedClassTag))
		{
			AssetObject->SetStringField(TEXT("generated_class"), GeneratedClassTag);
		}

		// ParentClass from tag
		FString ParentClassTag;
		if (AssetData.GetTagValue(FBlueprintTags::ParentClassPath, ParentClassTag))
		{
			AssetObject->SetStringField(TEXT("parent_class"), ParentClassTag);

			// Extract native parent from the tag (class name after the last '.')
			const int32 DotIdx = ParentClassTag.Find(TEXT("."), ESearchCase::IgnoreCase, ESearchDir::FromEnd);
			if (DotIdx != INDEX_NONE)
			{
				FString ParentClassName = ParentClassTag.Mid(DotIdx + 1);
				// Remove trailing _C suffix if present (generated class suffix)
				if (ParentClassName.EndsWith(TEXT("_C")))
				{
					ParentClassName = ParentClassName.LeftChop(2);
				}
				// Remove trailing ' (quote) from path notation
				ParentClassName.RemoveFromEnd(TEXT("'"));
				TArray<TSharedPtr<FJsonValue>> NativeParents;
				NativeParents.Add(MakeShared<FJsonValueString>(ParentClassName));
				AssetObject->SetArrayField(TEXT("native_parents"), NativeParents);
			}
		}

		// NativeParentClass tag (more reliable for native parents)
		FString NativeParentClassTag;
		if (AssetData.GetTagValue(FBlueprintTags::NativeParentClassPath, NativeParentClassTag))
		{
			const int32 DotIdx = NativeParentClassTag.Find(TEXT("."), ESearchCase::IgnoreCase, ESearchDir::FromEnd);
			if (DotIdx != INDEX_NONE)
			{
				FString NativeClassName = NativeParentClassTag.Mid(DotIdx + 1);
				NativeClassName.RemoveFromEnd(TEXT("'"));
				TArray<TSharedPtr<FJsonValue>> NativeParents;
				NativeParents.Add(MakeShared<FJsonValueString>(NativeClassName));
				AssetObject->SetArrayField(TEXT("native_parents"), NativeParents);
			}
		}

		// Dependencies from AssetRegistry (no loading needed)
		TArray<FName> Dependencies;
		AssetRegistry.GetDependencies(AssetData.PackageName, Dependencies, UE::AssetRegistry::EDependencyCategory::Package);
		TArray<TSharedPtr<FJsonValue>> DependencyValues;
		for (const FName& Dependency : Dependencies)
		{
			DependencyValues.Add(MakeShared<FJsonValueString>(Dependency.ToString()));
		}
		AssetObject->SetArrayField(TEXT("dependencies"), DependencyValues);

		// native_function_refs not available in metadata mode
		AssetObject->SetArrayField(TEXT("native_function_refs"), TArray<TSharedPtr<FJsonValue>>());

		// File modification timestamp for incremental change detection
		const FString FileModifiedAt = GetAssetFileModifiedAt(AssetData);
		if (!FileModifiedAt.IsEmpty())
		{
			AssetObject->SetStringField(TEXT("file_modified_at"), FileModifiedAt);
		}

		AssetValues.Add(MakeShared<FJsonValueObject>(AssetObject));
	}

	UE_LOG(LogTemp, Display, TEXT("GitNexusBlueprintAnalyzer: %d assets indexed (metadata mode)"), AssetValues.Num());

	TSharedPtr<FJsonObject> RootObject = MakeShared<FJsonObject>();
	RootObject->SetNumberField(TEXT("version"), 1);
	RootObject->SetStringField(TEXT("generated_at"), FDateTime::UtcNow().ToIso8601());
	RootObject->SetStringField(TEXT("project_path"), FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath()));
	RootObject->SetStringField(TEXT("mode"), TEXT("metadata"));
	RootObject->SetArrayField(TEXT("assets"), AssetValues);

	return WriteJsonToFile(OutputJsonPath, RootObject) ? 0 : 1;
}

// ── Deep sync (--deep) ──────────────────────────────────────────────────
// Loads each Blueprint fully to extract native_function_refs from graphs.
// Uses batch GC to prevent OOM on large projects.

static constexpr int32 DEEP_BATCH_SIZE = 50;

int32 UGitNexusBlueprintAnalyzerCommandlet::RunSyncAssetsDeep(
	const FString& OutputJsonPath,
	const TArray<FAssetData>& Assets,
	const TMap<FString, FString>& KnownAssets)
{
	TArray<TSharedPtr<FJsonValue>> AssetValues;
	TArray<TSharedPtr<FJsonValue>> SkippedPathValues;
	int32 SkippedCount = 0;
	int32 ChangedCount = 0;
	int32 BatchCounter = 0;

	for (const FAssetData& AssetData : Assets)
	{
		const FSoftObjectPath SoftPath = AssetData.GetSoftObjectPath();

		// Incremental skip: if this asset is known AND unchanged, skip loading entirely
		if (KnownAssets.Num() > 0)
		{
			const FString AssetPathStr = SoftPath.ToString();
			const FString* StoredMtime = KnownAssets.Find(AssetPathStr);
			if (StoredMtime)
			{
				const FString CurrentMtime = GetAssetFileModifiedAt(AssetData);
				if (!CurrentMtime.IsEmpty() && CurrentMtime == *StoredMtime)
				{
					// File unchanged — skip loading
					SkippedPathValues.Add(MakeShared<FJsonValueString>(AssetPathStr));
					continue;
				}
				// File changed — re-index
				ChangedCount++;
			}
		}
		UObject* LoadedAsset = SoftPath.TryLoad();
		UBlueprint* Blueprint = LoadedAsset ? Cast<UBlueprint>(LoadedAsset) : nullptr;
		if (!LoadedAsset)
		{
			SkippedCount++;
			UE_LOG(LogTemp, Warning, TEXT("GitNexusBlueprintAnalyzer: Skipped asset (failed to load): %s"), *AssetData.PackageName.ToString());
			continue;
		}
		if (!Blueprint)
		{
			// Non-Blueprint asset (e.g. UStateTree / UDataAsset): emit metadata-only entry
			TSharedPtr<FJsonObject> AssetObject = MakeShared<FJsonObject>();
			AssetObject->SetStringField(TEXT("asset_path"), AssetData.GetSoftObjectPath().ToString());
			AssetObject->SetStringField(TEXT("asset_class"), AssetData.AssetClassPath.ToString());
			TArray<FName> Deps;
			IAssetRegistry::GetChecked().GetDependencies(AssetData.PackageName, Deps, UE::AssetRegistry::EDependencyCategory::Package);
			TArray<TSharedPtr<FJsonValue>> DepValues;
			for (const FName& Dep : Deps)
				DepValues.Add(MakeShared<FJsonValueString>(Dep.ToString()));
			AssetObject->SetArrayField(TEXT("dependencies"), DepValues);
			const FString NonBpMtime = GetAssetFileModifiedAt(AssetData);
			if (!NonBpMtime.IsEmpty())
			{
				AssetObject->SetStringField(TEXT("file_modified_at"), NonBpMtime);
			}
			AssetValues.Add(MakeShared<FJsonValueObject>(AssetObject));
			continue;
		}

		TSharedPtr<FJsonObject> AssetObject = MakeShared<FJsonObject>();
		AssetObject->SetStringField(TEXT("asset_path"), AssetData.GetSoftObjectPath().ToString());
		AssetObject->SetStringField(TEXT("asset_class"), AssetData.AssetClassPath.ToString());

		if (Blueprint->GeneratedClass)
		{
			AssetObject->SetStringField(TEXT("generated_class"), Blueprint->GeneratedClass->GetPathName());
		}

		if (Blueprint->ParentClass)
		{
			AssetObject->SetStringField(TEXT("parent_class"), Blueprint->ParentClass->GetPathName());
		}

		TArray<TSharedPtr<FJsonValue>> NativeParents;
		for (UClass* Class = Blueprint->ParentClass; Class; Class = Class->GetSuperClass())
		{
			if (Class->ClassGeneratedBy == nullptr)
			{
				NativeParents.Add(MakeShared<FJsonValueString>(Class->GetName()));
			}
		}
		AssetObject->SetArrayField(TEXT("native_parents"), NativeParents);

		TArray<FName> Dependencies;
		IAssetRegistry::GetChecked().GetDependencies(AssetData.PackageName, Dependencies, UE::AssetRegistry::EDependencyCategory::Package);
		TArray<TSharedPtr<FJsonValue>> DependencyValues;
		for (const FName& Dependency : Dependencies)
		{
			DependencyValues.Add(MakeShared<FJsonValueString>(Dependency.ToString()));
		}
		AssetObject->SetArrayField(TEXT("dependencies"), DependencyValues);

		TArray<UEdGraph*> Graphs;
		CollectBlueprintGraphs(Blueprint, Graphs);
		TSet<FString> NativeFunctionRefs;
		for (const UEdGraph* Graph : Graphs)
		{
			if (!Graph)
			{
				continue;
			}

			for (const UEdGraphNode* Node : Graph->Nodes)
			{
				if (const UK2Node_CallFunction* CallNode = Cast<UK2Node_CallFunction>(Node))
				{
					if (const UFunction* TargetFunction = CallNode->GetTargetFunction())
					{
						const UClass* OwnerClass = TargetFunction->GetOwnerClass();
						const FString SymbolKey = OwnerClass
							? FString::Printf(TEXT("%s::%s"), *OwnerClass->GetName(), *TargetFunction->GetName())
							: TargetFunction->GetName();
						NativeFunctionRefs.Add(SymbolKey);
					}
				}
			}
		}

		TArray<TSharedPtr<FJsonValue>> NativeFunctionRefValues;
		for (const FString& Ref : NativeFunctionRefs)
		{
			NativeFunctionRefValues.Add(MakeShared<FJsonValueString>(Ref));
		}
		AssetObject->SetArrayField(TEXT("native_function_refs"), NativeFunctionRefValues);

		// ── Implemented Interfaces ──────────────────────────────────────
		TArray<TSharedPtr<FJsonValue>> InterfaceValues;
		for (const FBPInterfaceDescription& Interface : Blueprint->ImplementedInterfaces)
		{
			if (Interface.Interface)
			{
				InterfaceValues.Add(MakeShared<FJsonValueString>(Interface.Interface->GetPathName()));
			}
		}
		if (InterfaceValues.Num() > 0)
		{
			AssetObject->SetArrayField(TEXT("implements_interfaces"), InterfaceValues);
		}

		// ── Event Overrides (BlueprintImplementableEvent / BlueprintNativeEvent) ─
		TArray<TSharedPtr<FJsonValue>> EventOverrideValues;
		TSet<FString> SeenOverrides;
		for (const UEdGraph* Graph : Graphs)
		{
			if (!Graph) continue;
			for (const UEdGraphNode* Node : Graph->Nodes)
			{
				const UK2Node_Event* EventNode = Cast<UK2Node_Event>(Node);
				if (!EventNode) continue;
				const FName EventName = EventNode->EventReference.GetMemberName();
				if (EventName.IsNone()) continue;
				// Only emit if this overrides a parent function (not a custom event)
				const UClass* EventOwner = EventNode->EventReference.GetMemberParentClass();
				if (!EventOwner || EventOwner == Blueprint->GeneratedClass) continue;
				const FString Key = FString::Printf(TEXT("%s::%s"), *EventOwner->GetName(), *EventName.ToString());
				if (SeenOverrides.Contains(Key)) continue;
				SeenOverrides.Add(Key);
				TSharedPtr<FJsonObject> Override = MakeShared<FJsonObject>();
				Override->SetStringField(TEXT("event_name"), EventName.ToString());
				Override->SetStringField(TEXT("owner_class"), EventOwner->GetName());
				EventOverrideValues.Add(MakeShared<FJsonValueObject>(Override));
			}
		}
		if (EventOverrideValues.Num() > 0)
		{
			AssetObject->SetArrayField(TEXT("event_overrides"), EventOverrideValues);
		}

		// ── Event Dispatcher Bindings ───────────────────────────────────
		TArray<TSharedPtr<FJsonValue>> DispatcherValues;
		TSet<FString> SeenDispatchers;
		for (const UEdGraph* Graph : Graphs)
		{
			if (!Graph) continue;
			for (const UEdGraphNode* Node : Graph->Nodes)
			{
				const UK2Node_CreateDelegate* DelegateNode = Cast<UK2Node_CreateDelegate>(Node);
				if (!DelegateNode) continue;
				const FName DelegateName = DelegateNode->GetDelegateSignature() ? DelegateNode->GetDelegateSignature()->GetFName() : NAME_None;
				if (DelegateName.IsNone()) continue;
				const FString DelegateStr = DelegateName.ToString();
				if (SeenDispatchers.Contains(DelegateStr)) continue;
				SeenDispatchers.Add(DelegateStr);
				DispatcherValues.Add(MakeShared<FJsonValueString>(DelegateStr));
			}
		}
		if (DispatcherValues.Num() > 0)
		{
			AssetObject->SetArrayField(TEXT("event_dispatchers"), DispatcherValues);
		}

		// ── Gameplay Tags ──────────────────────────────────────────────
		TArray<TSharedPtr<FJsonValue>> TagValues;
		TSet<FString> SeenTags;
		// Walk all properties in the CDO looking for FGameplayTag/FGameplayTagContainer
		if (Blueprint->GeneratedClass)
		{
			UObject* CDO = Blueprint->GeneratedClass->GetDefaultObject();
			if (CDO)
			{
				for (TFieldIterator<FProperty> PropIt(Blueprint->GeneratedClass); PropIt; ++PropIt)
				{
					FProperty* Prop = *PropIt;
					if (const FStructProperty* StructProp = CastField<FStructProperty>(Prop))
					{
						if (StructProp->Struct == FGameplayTag::StaticStruct())
						{
							const FGameplayTag* TagPtr = StructProp->ContainerPtrToValuePtr<FGameplayTag>(CDO);
							if (TagPtr && TagPtr->IsValid())
							{
								const FString TagStr = TagPtr->GetTagName().ToString();
								if (!SeenTags.Contains(TagStr))
								{
									SeenTags.Add(TagStr);
									TagValues.Add(MakeShared<FJsonValueString>(TagStr));
								}
							}
						}
						else if (StructProp->Struct == FGameplayTagContainer::StaticStruct())
						{
							const FGameplayTagContainer* ContainerPtr = StructProp->ContainerPtrToValuePtr<FGameplayTagContainer>(CDO);
							if (ContainerPtr)
							{
								for (const FGameplayTag& Tag : *ContainerPtr)
								{
									if (Tag.IsValid())
									{
										const FString TagStr = Tag.GetTagName().ToString();
										if (!SeenTags.Contains(TagStr))
										{
											SeenTags.Add(TagStr);
											TagValues.Add(MakeShared<FJsonValueString>(TagStr));
										}
									}
								}
							}
						}
					}
				}
			}
		}
		if (TagValues.Num() > 0)
		{
			AssetObject->SetArrayField(TEXT("gameplay_tags"), TagValues);
		}

		// ── Blueprint Execution Flows ────────────────────────────────────
		TArray<TSharedPtr<FJsonValue>> FlowValues;
		for (const UEdGraph* Graph : Graphs)
		{
			if (!Graph) continue;
			// Find entry event nodes
			for (const UEdGraphNode* Node : Graph->Nodes)
			{
				const UK2Node_Event* EventNode = Cast<UK2Node_Event>(Node);
				if (!EventNode) continue;

				// BFS from this event along exec pins
				TArray<TSharedPtr<FJsonValue>> StepValues;
				TSet<const UEdGraphNode*> FlowVisited;
				TArray<const UEdGraphNode*> FlowQueue;
				FlowQueue.Add(EventNode);
				FlowVisited.Add(EventNode);
				int32 FlowDepth = 0;
				const int32 MaxFlowDepth = 15;

				while (FlowQueue.Num() > 0 && FlowDepth < MaxFlowDepth)
				{
					TArray<const UEdGraphNode*> NextQueue;
					for (const UEdGraphNode* Current : FlowQueue)
					{
						TSharedPtr<FJsonObject> StepObj = MakeShared<FJsonObject>();
						StepObj->SetStringField(TEXT("node_id"), Current->NodeGuid.ToString());
						StepObj->SetStringField(TEXT("node_kind"), Current->GetClass()->GetName());
						StepObj->SetStringField(TEXT("node_title"), Current->GetNodeTitle(ENodeTitleType::ListView).ToString());
						StepObj->SetNumberField(TEXT("depth"), FlowDepth);
						if (Graph->GetName().Len() > 0)
						{
							StepObj->SetStringField(TEXT("graph_name"), Graph->GetName());
						}
						StepValues.Add(MakeShared<FJsonValueObject>(StepObj));

						// Follow exec output pins
						for (const UEdGraphPin* ExecPin : Current->Pins)
						{
							if (ExecPin->Direction != EGPD_Output) continue;
							if (ExecPin->PinType.PinCategory != UEdGraphSchema_K2::PC_Exec) continue;
							for (const UEdGraphPin* LinkedPin : ExecPin->LinkedTo)
							{
								if (LinkedPin && LinkedPin->GetOwningNode() && !FlowVisited.Contains(LinkedPin->GetOwningNode()))
								{
									FlowVisited.Add(LinkedPin->GetOwningNode());
									NextQueue.Add(LinkedPin->GetOwningNode());
								}
							}
						}
					}
					FlowQueue = NextQueue;
					FlowDepth++;
				}

				if (StepValues.Num() > 1)  // Only emit flows with more than just the entry event
				{
					TSharedPtr<FJsonObject> FlowObj = MakeShared<FJsonObject>();
					const FName EventName = EventNode->EventReference.GetMemberName();
					FlowObj->SetStringField(TEXT("event_name"), EventName.IsNone() ? EventNode->GetNodeTitle(ENodeTitleType::ListView).ToString() : EventName.ToString());
					FlowObj->SetArrayField(TEXT("steps"), StepValues);
					FlowValues.Add(MakeShared<FJsonValueObject>(FlowObj));
				}
			}
		}
		if (FlowValues.Num() > 0)
		{
			AssetObject->SetArrayField(TEXT("flows"), FlowValues);
		}

		// File modification timestamp for incremental change detection
		const FString FileModifiedAt = GetAssetFileModifiedAt(AssetData);
		if (!FileModifiedAt.IsEmpty())
		{
			AssetObject->SetStringField(TEXT("file_modified_at"), FileModifiedAt);
		}

		AssetValues.Add(MakeShared<FJsonValueObject>(AssetObject));

		// Batch GC to prevent OOM on large projects
		BatchCounter++;
		if (BatchCounter >= DEEP_BATCH_SIZE)
		{
			CollectGarbage(GARBAGE_COLLECTION_KEEPFLAGS);
			BatchCounter = 0;
			UE_LOG(LogTemp, Display, TEXT("GitNexusBlueprintAnalyzer: Processed %d / %d assets (GC)"), AssetValues.Num(), Assets.Num());
		}
	}

	if (SkippedCount > 0)
	{
		UE_LOG(LogTemp, Warning, TEXT("GitNexusBlueprintAnalyzer: %d assets skipped (failed to load)"), SkippedCount);
	}
	if (SkippedPathValues.Num() > 0)
	{
		UE_LOG(LogTemp, Display, TEXT("GitNexusBlueprintAnalyzer: %d unchanged assets skipped, %d changed assets re-indexed (incremental)"), SkippedPathValues.Num(), ChangedCount);
	}
	UE_LOG(LogTemp, Display, TEXT("GitNexusBlueprintAnalyzer: %d assets indexed (deep mode)"), AssetValues.Num());

	TSharedPtr<FJsonObject> RootObject = MakeShared<FJsonObject>();
	RootObject->SetNumberField(TEXT("version"), 1);
	RootObject->SetStringField(TEXT("generated_at"), FDateTime::UtcNow().ToIso8601());
	RootObject->SetStringField(TEXT("project_path"), FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath()));
	RootObject->SetStringField(TEXT("mode"), TEXT("deep"));
	RootObject->SetArrayField(TEXT("assets"), AssetValues);
	if (SkippedPathValues.Num() > 0)
	{
		RootObject->SetArrayField(TEXT("skipped_paths"), SkippedPathValues);
	}

	return WriteJsonToFile(OutputJsonPath, RootObject) ? 0 : 1;
}

// ── FindNativeBlueprintReferences ───────────────────────────────────────

int32 UGitNexusBlueprintAnalyzerCommandlet::RunFindNativeBlueprintReferences(
	const FString& OutputJsonPath,
	const FString& CandidatesJsonPath,
	const FString& TargetSymbolKey,
	const FString& TargetClassName,
	const FString& TargetFunctionName
)
{
	TArray<TSharedPtr<FJsonValue>> ConfirmedReferences;
	TArray<FString> CandidateAssets = LoadCandidateAssets(CandidatesJsonPath);

	for (const FString& AssetPath : CandidateAssets)
	{
		UBlueprint* Blueprint = LoadBlueprintFromAssetPath(AssetPath);
		if (!Blueprint)
		{
			continue;
		}

		TArray<UEdGraph*> Graphs;
		CollectBlueprintGraphs(Blueprint, Graphs);
		for (const UEdGraph* Graph : Graphs)
		{
			if (!Graph)
			{
				continue;
			}

			for (const UEdGraphNode* Node : Graph->Nodes)
			{
				if (Node && IsTargetFunctionNode(Node, TargetSymbolKey, TargetClassName, TargetFunctionName))
				{
					ConfirmedReferences.Add(MakeShared<FJsonValueObject>(BuildReferenceJson(Blueprint, Graph, Node)));
				}
			}
		}
	}

	TSharedPtr<FJsonObject> RootObject = MakeShared<FJsonObject>();
	TSharedPtr<FJsonObject> TargetObject = MakeShared<FJsonObject>();
	TargetObject->SetStringField(TEXT("symbol_key"), TargetSymbolKey);
	TargetObject->SetStringField(TEXT("class_name"), TargetClassName);
	TargetObject->SetStringField(TEXT("symbol_name"), TargetFunctionName);
	RootObject->SetObjectField(TEXT("target_function"), TargetObject);
	RootObject->SetNumberField(TEXT("candidates_scanned"), CandidateAssets.Num());
	RootObject->SetArrayField(TEXT("confirmed_references"), ConfirmedReferences);

	return WriteJsonToFile(OutputJsonPath, RootObject) ? 0 : 1;
}

// ── ExpandBlueprintChain ────────────────────────────────────────────────

int32 UGitNexusBlueprintAnalyzerCommandlet::RunExpandBlueprintChain(
	const FString& OutputJsonPath,
	const FString& AssetPath,
	const FString& ChainAnchorId,
	const FString& Direction,
	int32 MaxDepth
)
{
	UBlueprint* Blueprint = LoadBlueprintFromAssetPath(AssetPath);
	if (!Blueprint)
	{
		return 1;
	}

	UEdGraphNode* StartNode = FindNodeByGuid(Blueprint, ChainAnchorId);
	if (!StartNode)
	{
		return 1;
	}

	struct FChainFrontierEntry
	{
		UEdGraphNode* Node;
		int32 Depth;
		FString TraversedFromPinName;
		FGuid TraversedFromNodeId;
	};

	TArray<TSharedPtr<FJsonValue>> NodeValues;
	TSet<FGuid> Visited;
	TArray<FChainFrontierEntry> Frontier;
	Frontier.Add({ StartNode, 0, FString(), FGuid() });
	Visited.Add(StartNode->NodeGuid);

	const bool bUpstream = Direction.Equals(TEXT("upstream"), ESearchCase::IgnoreCase);

	while (Frontier.Num() > 0)
	{
		const FChainFrontierEntry Current = Frontier[0];
		Frontier.RemoveAt(0);

		NodeValues.Add(MakeShared<FJsonValueObject>(BuildChainNodeJson(
			Current.Node->GetGraph(), Current.Node, Current.Depth,
			Current.TraversedFromPinName, Current.TraversedFromNodeId)));
		if (Current.Depth >= MaxDepth)
		{
			continue;
		}

		for (UEdGraphPin* Pin : Current.Node->Pins)
		{
			if (!Pin)
			{
				continue;
			}

			const bool bMatchesDirection = bUpstream ? Pin->Direction == EGPD_Input : Pin->Direction == EGPD_Output;
			if (!bMatchesDirection)
			{
				continue;
			}

			for (UEdGraphPin* LinkedPin : Pin->LinkedTo)
			{
				if (!LinkedPin || !LinkedPin->GetOwningNode())
				{
					continue;
				}

				UEdGraphNode* NextNode = LinkedPin->GetOwningNode();
				if (Visited.Contains(NextNode->NodeGuid))
				{
					continue;
				}

				// NOTE: In diamond-shaped graphs, BFS only records the first-discovered parent.
				Visited.Add(NextNode->NodeGuid);
				Frontier.Add({ NextNode, Current.Depth + 1, Pin->PinName.ToString(), Current.Node->NodeGuid });
			}
		}
	}

	TSharedPtr<FJsonObject> RootObject = MakeShared<FJsonObject>();
	RootObject->SetArrayField(TEXT("nodes"), NodeValues);
	return WriteJsonToFile(OutputJsonPath, RootObject) ? 0 : 1;
}

// ── Utility functions ───────────────────────────────────────────────────

bool UGitNexusBlueprintAnalyzerCommandlet::WriteJsonToFile(const FString& OutputJsonPath, const TSharedPtr<FJsonObject>& RootObject) const
{
	FString JsonText;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&JsonText);
	if (!FJsonSerializer::Serialize(RootObject.ToSharedRef(), Writer))
	{
		return false;
	}

	return FFileHelper::SaveStringToFile(JsonText, *OutputJsonPath, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
}

TArray<FString> UGitNexusBlueprintAnalyzerCommandlet::LoadCandidateAssets(const FString& CandidatesJsonPath) const
{
	TArray<FString> Result;
	if (CandidatesJsonPath.IsEmpty())
	{
		return Result;
	}

	FString RawJson;
	if (!FFileHelper::LoadFileToString(RawJson, *CandidatesJsonPath))
	{
		return Result;
	}

	TSharedPtr<FJsonObject> RootObject;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RawJson);
	if (!FJsonSerializer::Deserialize(Reader, RootObject) || !RootObject.IsValid())
	{
		return Result;
	}

	const TArray<TSharedPtr<FJsonValue>>* CandidateValues = nullptr;
	if (!RootObject->TryGetArrayField(TEXT("candidate_assets"), CandidateValues) || !CandidateValues)
	{
		return Result;
	}

	for (const TSharedPtr<FJsonValue>& Value : *CandidateValues)
	{
		const TSharedPtr<FJsonObject>* CandidateObject = nullptr;
		if (Value.IsValid() && Value->TryGetObject(CandidateObject) && CandidateObject && CandidateObject->IsValid())
		{
			FString AssetPath;
			if ((*CandidateObject)->TryGetStringField(TEXT("asset_path"), AssetPath))
			{
				Result.Add(AssetPath);
			}
		}
	}

	return Result;
}

// ── Pattern matching helpers ────────────────────────────────────────────────

/**
 * Recursive glob match.
 *   *   matches any sequence of non-separator characters
 *   **  matches any sequence of characters including /
 *   ?   matches any single non-separator character
 * Both Path and Pat must already be uppercased for case-insensitive matching.
 */
static bool GlobMatchImpl(const TCHAR* Path, const TCHAR* Pat)
{
	while (*Pat)
	{
		if (Pat[0] == TEXT('*') && Pat[1] == TEXT('*'))
		{
			Pat += 2;
			if (*Pat == TEXT('/')) ++Pat; // consume separator after **
			if (!*Pat) return true;       // ** at end matches everything remaining
			// Try remaining pattern only at segment boundaries (positions after '/'),
			// not at every character — prevents "BURST_" from matching "ST_*".
			const TCHAR* Segment = Path;
			while (true)
			{
				if (GlobMatchImpl(Segment, Pat)) return true;
				while (*Segment && *Segment != TEXT('/')) ++Segment;
				if (!*Segment) break;
				++Segment; // skip the '/'
			}
			return false;
		}
		if (*Pat == TEXT('*'))
		{
			++Pat;
			// * does not cross path separators
			while (*Path && *Path != TEXT('/'))
			{
				if (GlobMatchImpl(Path++, Pat)) return true;
			}
			return GlobMatchImpl(Path, Pat);
		}
		if (*Pat == TEXT('?'))
		{
			if (!*Path || *Path == TEXT('/')) return false;
			++Path; ++Pat;
		}
		else
		{
			if (*Path != *Pat) return false;
			++Path; ++Pat;
		}
	}
	return !*Path;
}

/** Case-insensitive glob match of a full Unreal package path against a pattern. */
static bool GlobMatches(const FString& Path, const FString& Pattern)
{
	return GlobMatchImpl(*Path.ToUpper(), *Pattern.ToUpper());
}

/**
 * Match a package path against a single pattern entry.
 * Patterns starting with "regex:" use FRegexMatcher (partial match — anchor with ^ and $ for full match).
 * All other patterns use glob matching (* / ** / ?).
 */
static bool MatchesPattern(const FString& PackagePath, const FString& Pattern)
{
	if (Pattern.StartsWith(TEXT("regex:")))
	{
		const FString RegexStr = Pattern.Mid(6); // strip "regex:" prefix
		const FRegexPattern RegexPattern(RegexStr);
		FRegexMatcher Matcher(RegexPattern, PackagePath);
		return Matcher.FindNext();
	}
	return GlobMatches(PackagePath, Pattern);
}

// ────────────────────────────────────────────────────────────────────────────

UGitNexusBlueprintAnalyzerCommandlet::FFilterPrefixes
UGitNexusBlueprintAnalyzerCommandlet::LoadFilterPrefixes(const FString& FilterJsonPath) const
{
	FFilterPrefixes Result;
	if (FilterJsonPath.IsEmpty())
	{
		return Result;
	}

	FString RawJson;
	if (!FFileHelper::LoadFileToString(RawJson, *FilterJsonPath))
	{
		UE_LOG(LogTemp, Warning, TEXT("GitNexusBlueprintAnalyzer: Could not read filter file: %s"), *FilterJsonPath);
		return Result;
	}

	TSharedPtr<FJsonObject> RootObject;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RawJson);
	if (!FJsonSerializer::Deserialize(Reader, RootObject) || !RootObject.IsValid())
	{
		return Result;
	}

	// Read include_prefixes (whitelist — if set, ONLY these paths are included)
	const TArray<TSharedPtr<FJsonValue>>* IncludeValues = nullptr;
	if (RootObject->TryGetArrayField(TEXT("include_prefixes"), IncludeValues) && IncludeValues)
	{
		for (const TSharedPtr<FJsonValue>& Value : *IncludeValues)
		{
			FString Prefix;
			if (Value.IsValid() && Value->TryGetString(Prefix))
			{
				Result.IncludePrefixes.Add(Prefix);
			}
		}
	}

	// Read exclude_prefixes (blacklist)
	const TArray<TSharedPtr<FJsonValue>>* ExcludeValues = nullptr;
	if (RootObject->TryGetArrayField(TEXT("exclude_prefixes"), ExcludeValues) && ExcludeValues)
	{
		for (const TSharedPtr<FJsonValue>& Value : *ExcludeValues)
		{
			FString Prefix;
			if (Value.IsValid() && Value->TryGetString(Prefix))
			{
				Result.ExcludePrefixes.Add(Prefix);
			}
		}
	}

	// Read include_patterns (glob or regex: whitelist patterns)
	const TArray<TSharedPtr<FJsonValue>>* IncludePatternValues = nullptr;
	if (RootObject->TryGetArrayField(TEXT("include_patterns"), IncludePatternValues) && IncludePatternValues)
	{
		for (const TSharedPtr<FJsonValue>& Value : *IncludePatternValues)
		{
			FString Pattern;
			if (Value.IsValid() && Value->TryGetString(Pattern))
			{
				Result.IncludePatterns.Add(Pattern);
			}
		}
	}

	// Read exclude_patterns (glob or regex: blacklist patterns)
	const TArray<TSharedPtr<FJsonValue>>* ExcludePatternValues = nullptr;
	if (RootObject->TryGetArrayField(TEXT("exclude_patterns"), ExcludePatternValues) && ExcludePatternValues)
	{
		for (const TSharedPtr<FJsonValue>& Value : *ExcludePatternValues)
		{
			FString Pattern;
			if (Value.IsValid() && Value->TryGetString(Pattern))
			{
				Result.ExcludePatterns.Add(Pattern);
			}
		}
	}

	if (Result.IncludePrefixes.Num() > 0)
	{
		UE_LOG(LogTemp, Display, TEXT("GitNexusBlueprintAnalyzer: Loaded %d include prefixes (whitelist)"), Result.IncludePrefixes.Num());
	}
	if (Result.IncludePatterns.Num() > 0)
	{
		UE_LOG(LogTemp, Display, TEXT("GitNexusBlueprintAnalyzer: Loaded %d include patterns (whitelist)"), Result.IncludePatterns.Num());
	}
	if (Result.ExcludePrefixes.Num() > 0)
	{
		UE_LOG(LogTemp, Display, TEXT("GitNexusBlueprintAnalyzer: Loaded %d exclude prefixes"), Result.ExcludePrefixes.Num());
	}
	if (Result.ExcludePatterns.Num() > 0)
	{
		UE_LOG(LogTemp, Display, TEXT("GitNexusBlueprintAnalyzer: Loaded %d exclude patterns"), Result.ExcludePatterns.Num());
	}

	// Read extra_asset_class_paths (non-Blueprint asset types like InputAction, BehaviorTree)
	const TArray<TSharedPtr<FJsonValue>>* ExtraClassValues = nullptr;
	if (RootObject->TryGetArrayField(TEXT("extra_asset_class_paths"), ExtraClassValues) && ExtraClassValues)
	{
		for (const TSharedPtr<FJsonValue>& Value : *ExtraClassValues)
		{
			FString ClassPath;
			if (Value.IsValid() && Value->TryGetString(ClassPath))
			{
				Result.ExtraAssetClassPaths.Add(ClassPath);
			}
		}
	}
	if (Result.ExtraAssetClassPaths.Num() > 0)
	{
		UE_LOG(LogTemp, Display, TEXT("GitNexusBlueprintAnalyzer: Loaded %d extra asset class paths"), Result.ExtraAssetClassPaths.Num());
	}

	return Result;
}

TMap<FString, FString> UGitNexusBlueprintAnalyzerCommandlet::LoadKnownAssets(const FString& KnownAssetsJsonPath) const
{
	TMap<FString, FString> Result;
	if (KnownAssetsJsonPath.IsEmpty())
	{
		return Result;
	}

	FString RawJson;
	if (!FFileHelper::LoadFileToString(RawJson, *KnownAssetsJsonPath))
	{
		UE_LOG(LogTemp, Warning, TEXT("GitNexusBlueprintAnalyzer: Could not read known assets file: %s"), *KnownAssetsJsonPath);
		return Result;
	}

	TSharedPtr<FJsonObject> RootObject;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(RawJson);
	if (!FJsonSerializer::Deserialize(Reader, RootObject) || !RootObject.IsValid())
	{
		return Result;
	}

	// Format: { "known_assets": { "/Game/X.X": "2026-04-01T08:00:00Z", ... } }
	const TSharedPtr<FJsonObject>* KnownAssetsObj = nullptr;
	if (RootObject->TryGetObjectField(TEXT("known_assets"), KnownAssetsObj) && KnownAssetsObj && KnownAssetsObj->IsValid())
	{
		for (const auto& Pair : (*KnownAssetsObj)->Values)
		{
			FString Mtime;
			if (Pair.Value.IsValid() && Pair.Value->TryGetString(Mtime))
			{
				Result.Add(Pair.Key, Mtime);
			}
		}
	}

	return Result;
}

FString UGitNexusBlueprintAnalyzerCommandlet::GetAssetFileModifiedAt(const FAssetData& AssetData)
{
	FString FilePath;
	if (FPackageName::TryConvertLongPackageNameToFilename(
			AssetData.PackageName.ToString(),
			FilePath,
			FPackageName::GetAssetPackageExtension()))
	{
		const FDateTime Timestamp = IFileManager::Get().GetTimeStamp(*FilePath);
		if (Timestamp != FDateTime::MinValue())
		{
			return Timestamp.ToIso8601();
		}
	}
	return FString();
}

TArray<FAssetData> UGitNexusBlueprintAnalyzerCommandlet::GetAllBlueprintAssets(const FFilterPrefixes& Filters) const
{
	FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
	IAssetRegistry& AssetRegistry = AssetRegistryModule.Get();
	AssetRegistry.SearchAllAssets(true);

	FARFilter Filter;
	Filter.ClassPaths.Add(UBlueprint::StaticClass()->GetClassPathName());
	// Also include StateTree assets (UStateTree derives from UDataAsset, not UBlueprint)
	Filter.ClassPaths.Add(FTopLevelAssetPath(FName("/Script/StateTreeModule"), FName("StateTree")));
	// Add extra asset class paths from filter JSON (non-Blueprint assets like InputAction, BehaviorTree, etc.)
	// Safe: GetAssets returns empty results for class paths whose module isn't loaded.
	for (const FString& ClassPath : Filters.ExtraAssetClassPaths)
	{
		int32 DotIdx;
		if (ClassPath.FindLastChar('.', DotIdx))
		{
			FString PackagePart = ClassPath.Left(DotIdx);
			FString ClassName = ClassPath.Mid(DotIdx + 1);
			Filter.ClassPaths.Add(FTopLevelAssetPath(FName(*PackagePart), FName(*ClassName)));
		}
	}
	Filter.bRecursiveClasses = true;

	TArray<FAssetData> AllAssets;
	AssetRegistry.GetAssets(Filter, AllAssets);

	const bool bHasIncludes = Filters.IncludePrefixes.Num() > 0 || Filters.IncludePatterns.Num() > 0;
	const bool bHasExcludes = Filters.ExcludePrefixes.Num() > 0 || Filters.ExcludePatterns.Num() > 0;

	if (!bHasIncludes && !bHasExcludes)
	{
		return AllAssets;
	}

	TArray<FAssetData> FilteredAssets;
	int32 IncludedCount = 0;
	int32 ExcludedCount = 0;

	for (const FAssetData& Asset : AllAssets)
	{
		const FString PackagePath = Asset.PackageName.ToString();

		// Include filter (whitelist): asset MUST match at least one prefix or pattern
		if (bHasIncludes)
		{
			bool bIncluded = false;
			for (const FString& Prefix : Filters.IncludePrefixes)
			{
				if (PackagePath.StartsWith(Prefix))
				{
					bIncluded = true;
					break;
				}
			}
			if (!bIncluded)
			{
				for (const FString& Pattern : Filters.IncludePatterns)
				{
					if (MatchesPattern(PackagePath, Pattern))
					{
						bIncluded = true;
						break;
					}
				}
			}
			if (!bIncluded)
			{
				IncludedCount++;
				continue;
			}
		}

		// Exclude filter (blacklist): skip assets matching any prefix or pattern
		if (bHasExcludes)
		{
			bool bExcluded = false;
			for (const FString& Prefix : Filters.ExcludePrefixes)
			{
				if (PackagePath.StartsWith(Prefix))
				{
					bExcluded = true;
					break;
				}
			}
			if (!bExcluded)
			{
				for (const FString& Pattern : Filters.ExcludePatterns)
				{
					if (MatchesPattern(PackagePath, Pattern))
					{
						bExcluded = true;
						break;
					}
				}
			}
			if (bExcluded)
			{
				ExcludedCount++;
				continue;
			}
		}

		FilteredAssets.Add(Asset);
	}

	UE_LOG(LogTemp, Display, TEXT("GitNexusBlueprintAnalyzer: %d assets after filtering (%d outside include scope, %d excluded)"),
		FilteredAssets.Num(), IncludedCount, ExcludedCount);
	return FilteredAssets;
}

UBlueprint* UGitNexusBlueprintAnalyzerCommandlet::LoadBlueprintFromAssetPath(const FString& AssetPath) const
{
	const FSoftObjectPath SoftObjectPath(AssetPath);
	return Cast<UBlueprint>(SoftObjectPath.TryLoad());
}

void UGitNexusBlueprintAnalyzerCommandlet::CollectBlueprintGraphs(UBlueprint* Blueprint, TArray<UEdGraph*>& OutGraphs) const
{
	if (!Blueprint)
	{
		return;
	}

	Blueprint->GetAllGraphs(OutGraphs);
}

bool UGitNexusBlueprintAnalyzerCommandlet::IsTargetFunctionNode(
	const UEdGraphNode* Node,
	const FString& TargetSymbolKey,
	const FString& TargetClassName,
	const FString& TargetFunctionName
) const
{
	if (const UK2Node_CallFunction* CallNode = Cast<UK2Node_CallFunction>(Node))
	{
		if (const UFunction* TargetFunction = CallNode->GetTargetFunction())
		{
			const UClass* OwnerClass = TargetFunction->GetOwnerClass();
			const FString SymbolKey = OwnerClass
				? FString::Printf(TEXT("%s::%s"), *OwnerClass->GetName(), *TargetFunction->GetName())
				: TargetFunction->GetName();
			return SymbolKey == TargetSymbolKey
				|| TargetFunction->GetName() == TargetFunctionName
				|| (OwnerClass && OwnerClass->GetName() == TargetClassName && TargetFunction->GetName() == TargetFunctionName);
		}
	}

	if (const UK2Node_Event* EventNode = Cast<UK2Node_Event>(Node))
	{
		return EventNode->GetFunctionName().ToString() == TargetFunctionName;
	}

	return false;
}

TSharedPtr<FJsonObject> UGitNexusBlueprintAnalyzerCommandlet::BuildReferenceJson(UBlueprint* Blueprint, const UEdGraph* Graph, const UEdGraphNode* Node) const
{
	TSharedPtr<FJsonObject> Object = MakeShared<FJsonObject>();
	Object->SetStringField(TEXT("asset_path"), Blueprint ? Blueprint->GetPathName() : FString());
	Object->SetStringField(TEXT("graph_name"), Graph ? Graph->GetName() : FString());
	Object->SetStringField(TEXT("node_kind"), Node ? Node->GetClass()->GetName() : FString());
	Object->SetStringField(TEXT("node_title"), Node ? Node->GetNodeTitle(ENodeTitleType::ListView).ToString() : FString());
	Object->SetStringField(TEXT("blueprint_owner_function"), Graph ? Graph->GetName() : FString());
	Object->SetStringField(TEXT("chain_anchor_id"), Node ? Node->NodeGuid.ToString(EGuidFormats::DigitsWithHyphens) : FString());
	Object->SetStringField(TEXT("source"), TEXT("editor_confirmed"));
	return Object;
}

TSharedPtr<FJsonObject> UGitNexusBlueprintAnalyzerCommandlet::BuildChainNodeJson(
	const UEdGraph* Graph, const UEdGraphNode* Node, int32 Depth,
	const FString& TraversedFromPinName, const FGuid& TraversedFromNodeId) const
{
	TSharedPtr<FJsonObject> Object = MakeShared<FJsonObject>();
	Object->SetStringField(TEXT("node_id"), Node ? Node->NodeGuid.ToString(EGuidFormats::DigitsWithHyphens) : FString());
	Object->SetStringField(TEXT("graph_name"), Graph ? Graph->GetName() : FString());
	Object->SetStringField(TEXT("node_kind"), Node ? Node->GetClass()->GetName() : FString());
	Object->SetStringField(TEXT("node_title"), Node ? Node->GetNodeTitle(ENodeTitleType::ListView).ToString() : FString());
	Object->SetNumberField(TEXT("depth"), Depth);

	if (!TraversedFromPinName.IsEmpty())
	{
		Object->SetStringField(TEXT("traversed_from_pin"), TraversedFromPinName);
	}
	if (TraversedFromNodeId.IsValid())
	{
		Object->SetStringField(TEXT("traversed_from_node"), TraversedFromNodeId.ToString(EGuidFormats::DigitsWithHyphens));
	}

	if (Node)
	{
		AnnotateNodeMetadata(Object, Node);
		Object->SetObjectField(TEXT("pins"), BuildPinsJson(Node));
		AnnotateNodeDetails(Object, Node);
	}

	return Object;
}

TSharedPtr<FJsonObject> UGitNexusBlueprintAnalyzerCommandlet::BuildPinJson(const UEdGraphPin* Pin) const
{
	TSharedPtr<FJsonObject> PinObj = MakeShared<FJsonObject>();
	if (!Pin)
	{
		return PinObj;
	}

	PinObj->SetStringField(TEXT("name"), Pin->PinName.ToString());
	PinObj->SetStringField(TEXT("direction"), Pin->Direction == EGPD_Input ? TEXT("input") : TEXT("output"));
	PinObj->SetStringField(TEXT("type"), Pin->PinType.PinCategory.ToString());

	if (Pin->PinType.PinSubCategoryObject.IsValid())
	{
		PinObj->SetStringField(TEXT("sub_type"), Pin->PinType.PinSubCategoryObject->GetName());
	}

	if (!Pin->DefaultValue.IsEmpty())
	{
		PinObj->SetStringField(TEXT("default_value"), Pin->DefaultValue);
	}
	else if (Pin->DefaultObject)
	{
		PinObj->SetStringField(TEXT("default_value"), Pin->DefaultObject->GetPathName());
	}

	if (Pin->LinkedTo.Num() > 0)
	{
		TArray<TSharedPtr<FJsonValue>> ConnectedTo;
		TArray<TSharedPtr<FJsonValue>> ConnectedToTitle;
		for (const UEdGraphPin* LinkedPin : Pin->LinkedTo)
		{
			if (LinkedPin && LinkedPin->GetOwningNode())
			{
				ConnectedTo.Add(MakeShared<FJsonValueString>(
					LinkedPin->GetOwningNode()->NodeGuid.ToString(EGuidFormats::DigitsWithHyphens)));
				ConnectedToTitle.Add(MakeShared<FJsonValueString>(
					LinkedPin->GetOwningNode()->GetNodeTitle(ENodeTitleType::ListView).ToString()));
			}
		}
		PinObj->SetArrayField(TEXT("connected_to"), ConnectedTo);
		PinObj->SetArrayField(TEXT("connected_to_title"), ConnectedToTitle);
	}

	return PinObj;
}

TSharedPtr<FJsonObject> UGitNexusBlueprintAnalyzerCommandlet::BuildPinsJson(const UEdGraphNode* Node) const
{
	TSharedPtr<FJsonObject> PinsObj = MakeShared<FJsonObject>();
	if (!Node)
	{
		return PinsObj;
	}

	TArray<TSharedPtr<FJsonValue>> ExecPins;
	TArray<TSharedPtr<FJsonValue>> DataPins;

	for (const UEdGraphPin* Pin : Node->Pins)
	{
		if (!Pin)
		{
			continue;
		}

		TSharedPtr<FJsonObject> PinJson = BuildPinJson(Pin);
		if (Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Exec)
		{
			ExecPins.Add(MakeShared<FJsonValueObject>(PinJson));
		}
		else
		{
			DataPins.Add(MakeShared<FJsonValueObject>(PinJson));
		}
	}

	PinsObj->SetArrayField(TEXT("exec_pins"), ExecPins);
	PinsObj->SetArrayField(TEXT("data_pins"), DataPins);
	return PinsObj;
}

void UGitNexusBlueprintAnalyzerCommandlet::AnnotateNodeMetadata(TSharedPtr<FJsonObject>& NodeObj, const UEdGraphNode* Node) const
{
	if (!Node)
	{
		return;
	}

	NodeObj->SetBoolField(TEXT("is_enabled"), Node->IsNodeEnabled());

	if (!Node->NodeComment.IsEmpty())
	{
		NodeObj->SetStringField(TEXT("comment"), Node->NodeComment);
	}
}

void UGitNexusBlueprintAnalyzerCommandlet::AnnotateNodeDetails(TSharedPtr<FJsonObject>& NodeObj, const UEdGraphNode* Node) const
{
	if (!Node)
	{
		return;
	}

	TSharedPtr<FJsonObject> Details = MakeShared<FJsonObject>();
	bool bHasDetails = false;

	if (const UK2Node_CallFunction* CallNode = Cast<UK2Node_CallFunction>(Node))
	{
		Details->SetBoolField(TEXT("is_pure"), CallNode->IsNodePure());
		if (const UFunction* TargetFunction = CallNode->GetTargetFunction())
		{
			Details->SetStringField(TEXT("function_name"), TargetFunction->GetName());
			if (const UClass* OwnerClass = TargetFunction->GetOwnerClass())
			{
				Details->SetStringField(TEXT("target_class"), OwnerClass->GetName());
			}
		}
		bHasDetails = true;
	}
	else if (const UK2Node_VariableGet* GetNode = Cast<UK2Node_VariableGet>(Node))
	{
		Details->SetStringField(TEXT("variable_name"), GetNode->GetVarName().ToString());
		Details->SetStringField(TEXT("node_role"), TEXT("variable_get"));
		bHasDetails = true;
	}
	else if (const UK2Node_VariableSet* SetNode = Cast<UK2Node_VariableSet>(Node))
	{
		Details->SetStringField(TEXT("variable_name"), SetNode->GetVarName().ToString());
		Details->SetStringField(TEXT("node_role"), TEXT("variable_set"));
		bHasDetails = true;
	}
	else if (Cast<UK2Node_IfThenElse>(Node))
	{
		Details->SetStringField(TEXT("branch_type"), TEXT("if_then_else"));
		bHasDetails = true;
	}
	else if (Cast<UK2Node_Switch>(Node))
	{
		Details->SetStringField(TEXT("branch_type"), TEXT("switch"));
		bHasDetails = true;
	}

	if (bHasDetails)
	{
		NodeObj->SetObjectField(TEXT("details"), Details);
	}
}

UEdGraphNode* UGitNexusBlueprintAnalyzerCommandlet::FindNodeByGuid(UBlueprint* Blueprint, const FString& NodeGuid) const
{
	if (!Blueprint)
	{
		return nullptr;
	}

	FGuid Guid;
	if (!FGuid::Parse(NodeGuid, Guid))
	{
		return nullptr;
	}

	TArray<UEdGraph*> Graphs;
	CollectBlueprintGraphs(Blueprint, Graphs);
	for (UEdGraph* Graph : Graphs)
	{
		if (!Graph)
		{
			continue;
		}

		for (UEdGraphNode* Node : Graph->Nodes)
		{
			if (Node && Node->NodeGuid == Guid)
			{
				return Node;
			}
		}
	}

	return nullptr;
}
