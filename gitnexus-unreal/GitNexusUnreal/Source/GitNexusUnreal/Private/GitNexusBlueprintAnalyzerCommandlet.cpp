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
#include "K2Node_CallFunction.h"
#include "K2Node_Event.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/SoftObjectPath.h"

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
		return RunSyncAssets(OutputJsonPath);
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

int32 UGitNexusBlueprintAnalyzerCommandlet::RunSyncAssets(const FString& OutputJsonPath)
{
	TArray<TSharedPtr<FJsonValue>> AssetValues;

	for (const FAssetData& AssetData : GetAllBlueprintAssets())
	{
		UBlueprint* Blueprint = Cast<UBlueprint>(AssetData.GetAsset());
		if (!Blueprint)
		{
			continue;
		}

		TSharedPtr<FJsonObject> AssetObject = MakeShared<FJsonObject>();
		AssetObject->SetStringField(TEXT("asset_path"), AssetData.GetSoftObjectPath().ToString());

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

		AssetValues.Add(MakeShared<FJsonValueObject>(AssetObject));
	}

	TSharedPtr<FJsonObject> RootObject = MakeShared<FJsonObject>();
	RootObject->SetNumberField(TEXT("version"), 1);
	RootObject->SetStringField(TEXT("generated_at"), FDateTime::UtcNow().ToIso8601());
	RootObject->SetStringField(TEXT("project_path"), FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath()));
	RootObject->SetArrayField(TEXT("assets"), AssetValues);

	return WriteJsonToFile(OutputJsonPath, RootObject) ? 0 : 1;
}

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

	TArray<TSharedPtr<FJsonValue>> NodeValues;
	TSet<FGuid> Visited;
	TArray<TPair<UEdGraphNode*, int32>> Frontier;
	Frontier.Add(TPair<UEdGraphNode*, int32>(StartNode, 0));
	Visited.Add(StartNode->NodeGuid);

	const bool bUpstream = Direction.Equals(TEXT("upstream"), ESearchCase::IgnoreCase);

	while (Frontier.Num() > 0)
	{
		const TPair<UEdGraphNode*, int32> Current = Frontier[0];
		Frontier.RemoveAt(0);

		NodeValues.Add(MakeShared<FJsonValueObject>(BuildChainNodeJson(Current.Key->GetGraph(), Current.Key, Current.Value)));
		if (Current.Value >= MaxDepth)
		{
			continue;
		}

		for (UEdGraphPin* Pin : Current.Key->Pins)
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

				Visited.Add(NextNode->NodeGuid);
				Frontier.Add(TPair<UEdGraphNode*, int32>(NextNode, Current.Value + 1));
			}
		}
	}

	TSharedPtr<FJsonObject> RootObject = MakeShared<FJsonObject>();
	RootObject->SetArrayField(TEXT("nodes"), NodeValues);
	return WriteJsonToFile(OutputJsonPath, RootObject) ? 0 : 1;
}

bool UGitNexusBlueprintAnalyzerCommandlet::WriteJsonToFile(const FString& OutputJsonPath, const TSharedPtr<FJsonObject>& RootObject) const
{
	FString JsonText;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&JsonText);
	if (!FJsonSerializer::Serialize(RootObject.ToSharedRef(), Writer))
	{
		return false;
	}

	return FFileHelper::SaveStringToFile(JsonText, *OutputJsonPath);
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

TArray<FAssetData> UGitNexusBlueprintAnalyzerCommandlet::GetAllBlueprintAssets() const
{
	FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
	IAssetRegistry& AssetRegistry = AssetRegistryModule.Get();
	AssetRegistry.SearchAllAssets(true);

	FARFilter Filter;
	Filter.ClassPaths.Add(UBlueprint::StaticClass()->GetClassPathName());
	Filter.bRecursiveClasses = true;

	TArray<FAssetData> Assets;
	AssetRegistry.GetAssets(Filter, Assets);
	return Assets;
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

TSharedPtr<FJsonObject> UGitNexusBlueprintAnalyzerCommandlet::BuildChainNodeJson(const UEdGraph* Graph, const UEdGraphNode* Node, int32 Depth) const
{
	TSharedPtr<FJsonObject> Object = MakeShared<FJsonObject>();
	Object->SetStringField(TEXT("node_id"), Node ? Node->NodeGuid.ToString(EGuidFormats::DigitsWithHyphens) : FString());
	Object->SetStringField(TEXT("graph_name"), Graph ? Graph->GetName() : FString());
	Object->SetStringField(TEXT("node_kind"), Node ? Node->GetClass()->GetName() : FString());
	Object->SetStringField(TEXT("node_title"), Node ? Node->GetNodeTitle(ENodeTitleType::ListView).ToString() : FString());
	Object->SetNumberField(TEXT("depth"), Depth);
	return Object;
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
